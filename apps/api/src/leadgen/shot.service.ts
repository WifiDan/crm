import { type Db } from "@crm/db";
import {
	BadGatewayException,
	BadRequestException,
	HttpException,
	HttpStatus,
	Inject,
	Injectable,
	NotFoundException,
	Optional,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import { safeHttpUrl } from "./lead-view";
import {
	assertPublicUrl,
	OutboundError,
	OutboundRefusedError,
	type Resolver,
	systemResolver,
} from "./outbound-guard";
import type { shotCaptureOutput, shotStatusOutput } from "./shot.contracts";
import {
	type CaptureDeps,
	captureScreenshot,
	findBrowser,
	ShotError,
} from "./shot-browser";
import {
	type CachedShot,
	readShot,
	SHOT_CACHE,
	shotName,
	writeShot,
} from "./shot-cache";

export const LG_SHOT_ENV = Symbol("LG_SHOT_ENV");

export type ShotEnv = {
	cacheDir: string;
	browserDir?: string;
	resolve?: Resolver;
	capture?: CaptureDeps;
	now?: () => Date;
	homeDir?: string;
};

export const defaultShotEnv = (
	env: Record<string, string | undefined>,
): ShotEnv => ({
	cacheDir: env.LEADGEN_SHOT_CACHE_DIR ?? "/data/leadgen/crm-shots",
	browserDir: env.LEADGEN_BROWSER_DIR,
});

export type ShotStatus = z.infer<typeof shotStatusOutput>;
export type ShotCapture = z.infer<typeof shotCaptureOutput>;

const MAX_PARALLEL = 3;

@Injectable()
export class LeadgenShotService {
	private running = 0;
	private readonly inflight = new Map<string, Promise<ShotCapture>>();

	constructor(
		@InjectDatabase() private readonly db: Db,
		@Optional()
		@Inject(LG_SHOT_ENV)
		private readonly env: ShotEnv = defaultShotEnv({}),
	) {}

	private now(): Date {
		return this.env.now ? this.env.now() : new Date();
	}

	private install() {
		return findBrowser(this.env.homeDir, this.env.browserDir);
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

	async status(leadId: string): Promise<ShotStatus> {
		const install = this.install();
		const unavailableReason = install
			? null
			: "The headless browser is not installed on this host.";
		const target = await this.targetOf(leadId).catch(() => null);
		const cached = target ? await this.cached(leadId, target) : null;
		return {
			available: install !== null,
			unavailableReason,
			cached: cached !== null,
			capturedAt: cached?.capturedAt.toISOString() ?? null,
			stale: cached ? !cached.fresh : false,
			url: target,
		};
	}

	async cached(leadId: string, target: string): Promise<CachedShot | null> {
		return readShot(this.env.cacheDir, shotName(leadId, target), this.now());
	}

	async image(leadId: string): Promise<CachedShot | null> {
		const target = await this.targetOf(leadId).catch(() => null);
		return target ? this.cached(leadId, target) : null;
	}

	async capture(leadId: string, force: boolean): Promise<ShotCapture> {
		const target = await this.targetOf(leadId);
		const existing = await this.cached(leadId, target);
		const recent =
			existing &&
			this.now().getTime() - existing.capturedAt.getTime() <
				SHOT_CACHE.forceMinAgeMs;
		if (existing?.fresh && (!force || recent))
			return this.fromCache(target, existing, null);
		const install = this.install();
		if (!install)
			throw new ServiceUnavailableException(
				"The headless browser is not installed on this host.",
			);
		await this.precheck(target);
		const key = shotName(leadId, target);
		const running = this.inflight.get(key);
		if (running) return running;
		const job = this.run(leadId, target, install, existing);
		this.inflight.set(key, job);
		try {
			return await job;
		} finally {
			this.inflight.delete(key);
		}
	}

	private async precheck(target: string): Promise<void> {
		try {
			await assertPublicUrl(target, this.env.resolve ?? systemResolver);
		} catch (e) {
			if (e instanceof OutboundRefusedError)
				throw new BadRequestException(`Not captured: ${e.message}`);
			if (e instanceof OutboundError)
				throw new BadGatewayException(`Not captured: ${e.message}`);
			throw e;
		}
	}

	private fromCache(
		target: string,
		shot: CachedShot,
		note: string | null,
	): ShotCapture {
		return {
			capturedAt: shot.capturedAt.toISOString(),
			fromCache: true,
			stale: !shot.fresh,
			url: target,
			finalUrl: null,
			httpStatus: null,
			bytes: shot.png.length,
			note,
		};
	}

	private async run(
		leadId: string,
		target: string,
		install: NonNullable<ReturnType<LeadgenShotService["install"]>>,
		existing: CachedShot | null,
	): Promise<ShotCapture> {
		if (this.running >= MAX_PARALLEL)
			throw new HttpException(
				"Too many screenshots are being taken. Try again in a few seconds.",
				HttpStatus.TOO_MANY_REQUESTS,
			);
		this.running += 1;
		try {
			const result = await captureScreenshot(install, target, this.env.capture);
			await writeShot(this.env.cacheDir, shotName(leadId, target), result.png);
			return {
				capturedAt: this.now().toISOString(),
				fromCache: false,
				stale: false,
				url: target,
				finalUrl: result.finalUrl,
				httpStatus: result.httpStatus,
				bytes: result.png.length,
				note:
					result.httpStatus !== null && result.httpStatus >= 400
						? `The site answered with HTTP ${result.httpStatus}.`
						: null,
			};
		} catch (e) {
			return this.failed(target, existing, e);
		} finally {
			this.running -= 1;
		}
	}

	private failed(
		target: string,
		existing: CachedShot | null,
		error: unknown,
	): ShotCapture {
		const why =
			error instanceof ShotError || error instanceof Error
				? error.message
				: "capture failed";
		if (existing)
			return this.fromCache(
				target,
				existing,
				`The new capture failed (${why}). Showing the earlier picture.`,
			);
		if (error instanceof ShotError && error.kind === "refused")
			throw new BadRequestException(`Not captured: ${why}`);
		throw new BadGatewayException(`Could not capture their site: ${why}`);
	}
}
