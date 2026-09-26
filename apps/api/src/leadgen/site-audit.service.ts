import { type Db } from "@crm/db";
import {
	BadRequestException,
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	NotFoundException,
	Optional,
} from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { auditName, readAudit, writeAudit } from "./audit-cache";
import { safeHttpUrl } from "./lead-view";
import { type FetchDeps, fetchPublic } from "./outbound-guard";
import { type AuditResult, auditFailure, scoreSite } from "./site-audit";

export const LG_OUTBOUND_DEPS = Symbol("LG_OUTBOUND_DEPS");
export const LG_AUDIT_ENV = Symbol("LG_AUDIT_ENV");

export const AUDIT_LIMITS = {
	maxBytes: 2_000_000,
	timeoutMs: 10_000,
	maxParallel: 3,
} as const;

export type AuditEnv = {
	cacheDir: string;
	now?: () => Date;
};

export const defaultAuditEnv = (
	env: Record<string, string | undefined>,
): AuditEnv => ({
	cacheDir: env.LEADGEN_AUDIT_CACHE_DIR ?? "/data/leadgen/crm-audits",
});

@Injectable()
export class SiteAuditService {
	private running = 0;

	constructor(
		@InjectDatabase() private readonly db: Db,
		@Optional() @Inject(LG_OUTBOUND_DEPS) private readonly deps?: FetchDeps,
		@Optional() @Inject(LG_AUDIT_ENV) private readonly env?: AuditEnv,
	) {}

	private now(): Date {
		return this.env?.now ? this.env.now() : new Date();
	}

	private async targetOf(leadId: string): Promise<string> {
		const lead = await this.db.lgLead.findFirst({
			where: { id: leadId, mirrorMissingAt: null },
			select: { websiteUrl: true },
		});
		if (!lead) throw new NotFoundException("Lead not found in the mirror.");
		const target = safeHttpUrl(lead.websiteUrl);
		if (!target) throw new BadRequestException("bad url");
		return target;
	}

	/** The cached audit for a lead, if one exists and has not gone stale. Never fetches. */
	async cached(leadId: string): Promise<AuditResult | null> {
		if (!this.env) return null;
		const target = await this.targetOf(leadId).catch(() => null);
		if (!target) return null;
		const hit = await readAudit(
			this.env.cacheDir,
			auditName(leadId, target),
			this.now(),
		);
		return hit?.fresh ? hit.result : null;
	}

	async run(
		leadId: string,
		opts: { force?: boolean } = {},
	): Promise<AuditResult> {
		const target = await this.targetOf(leadId);
		if (!opts.force && this.env) {
			const hit = await readAudit(
				this.env.cacheDir,
				auditName(leadId, target),
				this.now(),
			);
			if (hit?.fresh) return hit.result;
		}
		if (this.running >= AUDIT_LIMITS.maxParallel)
			throw new HttpException(
				"Too many audits are running. Try again in a few seconds.",
				HttpStatus.TOO_MANY_REQUESTS,
			);
		this.running += 1;
		try {
			const page = await fetchPublic(
				target,
				{
					maxBytes: AUDIT_LIMITS.maxBytes,
					timeoutMs: AUDIT_LIMITS.timeoutMs,
				},
				this.deps,
			);
			const result = scoreSite(page.text, target);
			if (this.env)
				await writeAudit(this.env.cacheDir, auditName(leadId, target), result);
			return result;
		} catch (e) {
			// A transient failure is not cached: it should not shadow a real
			// audit for the next 14 days once the site is reachable again.
			return auditFailure(
				target,
				e instanceof Error ? e.message : "request failed",
			);
		} finally {
			this.running -= 1;
		}
	}
}
