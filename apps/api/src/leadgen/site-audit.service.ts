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
import { safeHttpUrl } from "./lead-view";
import { type FetchDeps, fetchPublic } from "./outbound-guard";
import { type AuditResult, auditFailure, scoreSite } from "./site-audit";

export const LG_OUTBOUND_DEPS = Symbol("LG_OUTBOUND_DEPS");

export const AUDIT_LIMITS = {
	maxBytes: 2_000_000,
	timeoutMs: 10_000,
	maxParallel: 3,
} as const;

@Injectable()
export class SiteAuditService {
	private running = 0;

	constructor(
		@InjectDatabase() private readonly db: Db,
		@Optional() @Inject(LG_OUTBOUND_DEPS) private readonly deps?: FetchDeps,
	) {}

	async run(leadId: string): Promise<AuditResult> {
		const lead = await this.db.lgLead.findFirst({
			where: { id: leadId, mirrorMissingAt: null },
			select: { websiteUrl: true },
		});
		if (!lead) throw new NotFoundException("Lead not found in the mirror.");
		const target = safeHttpUrl(lead.websiteUrl);
		if (!target) throw new BadRequestException("bad url");
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
			return scoreSite(page.text, target);
		} catch (e) {
			return auditFailure(
				target,
				e instanceof Error ? e.message : "request failed",
			);
		} finally {
			this.running -= 1;
		}
	}
}
