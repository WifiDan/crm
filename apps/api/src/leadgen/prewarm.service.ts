import { Inject, Injectable, Logger } from "@nestjs/common";
import { LeadgenShotService } from "./shot.service";
import { SiteAuditService } from "./site-audit.service";

/**
 * Warms the screenshot + audit caches for one lead so that when a person
 * actually opens it in Triage/Review, both are already sitting in cache.
 *
 * Screenshots start a real headless Chrome, and Joshua's RAM is tight, so
 * every prewarm call funnels through one FIFO queue here: at most one
 * Chrome from prewarming at a time, no matter how many leads the UI asks
 * for concurrently. This queue is additional to (not a replacement for)
 * LeadgenShotService's own concurrency cap, which still protects manual
 * "Take a screenshot" clicks made outside of prewarming.
 *
 * Audits are a lightweight HTTP fetch (no browser), so they are not
 * serialized here; SiteAuditService already caps its own concurrency.
 *
 * Every failure is caught and logged; prepare() never rejects, so it is
 * always safe to call from request handlers or UI prefetch.
 */
@Injectable()
export class LeadgenPrewarmService {
	private readonly logger = new Logger(LeadgenPrewarmService.name);
	private queue: Promise<void> = Promise.resolve();

	constructor(
		@Inject(LeadgenShotService) private readonly shots: LeadgenShotService,
		@Inject(SiteAuditService) private readonly audits: SiteAuditService,
	) {}

	async prepare(leadId: string): Promise<{ shot: boolean; audit: boolean }> {
		const [audit, shot] = await Promise.all([
			this.prepareAudit(leadId),
			this.prepareShot(leadId),
		]);
		return { shot, audit };
	}

	private async prepareAudit(leadId: string): Promise<boolean> {
		try {
			const cached = await this.audits.cached(leadId);
			if (cached) return true;
			await this.audits.run(leadId);
			return true;
		} catch (e) {
			this.skip(leadId, "audit", e);
			return false;
		}
	}

	private prepareShot(leadId: string): Promise<boolean> {
		const task = this.queue.then(() => this.captureIfMissing(leadId));
		// Keep the queue moving even if this lead's capture fails.
		this.queue = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	private async captureIfMissing(leadId: string): Promise<boolean> {
		try {
			const status = await this.shots.status(leadId);
			if (!status.available) return false;
			if (status.cached && !status.stale) return true;
			await this.shots.capture(leadId, false);
			return true;
		} catch (e) {
			this.skip(leadId, "shot", e);
			return false;
		}
	}

	private skip(leadId: string, kind: "shot" | "audit", e: unknown): void {
		const message = e instanceof Error ? e.message : String(e);
		this.logger.warn(`${kind} prewarm skipped for lead ${leadId}: ${message}`);
	}
}
