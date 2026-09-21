import { type Db, type Prisma } from "@crm/db";
import {
	BadGatewayException,
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Inject,
	Injectable,
	InternalServerErrorException,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import type {
	decisionResultOutput,
	decisionStatusOutput,
} from "./lead-decision.contracts";
import {
	armingBlockers,
	armsSending,
	buildDecisionPatch,
	buildReworkPatch,
	type Decision,
	flagOf,
	isDecisionApprover,
	type LeadPatch,
	type LiveRow,
	type PoolConfig,
	poolOfTable,
	readDecisionPolicy,
	SEND_APPROVED_FIELD,
	type Seen,
	type Stage,
	staleFields,
	statusBlockers,
	verifyPatch,
	versionOf,
} from "./lead-decision.rules";
import {
	type LeadRowStore,
	LG_LEAD_STORE,
	NocoWriteError,
} from "./lead-decision.store";
import type { NocoRow } from "./outreach-plan";
import type { PythonSendState } from "./python-state";

export const LG_SEND_STATE = Symbol("LG_SEND_STATE");
export const LG_DECISION_CLOCK = Symbol("LG_DECISION_CLOCK");

export type SendStateLoader = (
	now: Date,
) => Promise<Pick<PythonSendState, "replied" | "openStops">>;
export type DecisionClock = () => Date;

export type Actor = { id: string; email: string | null };

export type DecideInput = {
	leadId: string;
	requestId: string;
	stage: Stage;
	decision: Decision;
	seen: Seen;
	confirmArm: boolean;
	actor: Actor;
};

export type ReworkInput = {
	leadId: string;
	requestId: string;
	notes: string;
	seen: Seen;
	actor: Actor;
};

export type DecisionResult = z.infer<typeof decisionResultOutput>;
export type DecisionStatus = z.infer<typeof decisionStatusOutput>;

type Target = {
	leadId: string;
	pool: PoolConfig;
	tableId: string;
	rowId: number;
};

type Plan = {
	action: "DECISION" | "REWORK";
	requestId: string;
	actor: Actor;
	target: Target;
	seen: Seen;
	stage: Stage | null;
	decision: Decision | null;
	notes: string | null;
	arms: boolean;
	patch: LeadPatch;
	now: Date;
};

const RECENT_PENDING_MS = 120_000;

@Injectable()
export class LeadDecisionService {
	private readonly logger = new Logger(LeadDecisionService.name);
	private readonly inflight = new Set<string>();

	constructor(
		@InjectDatabase() private readonly db: Db,
		@Inject(LG_LEAD_STORE) private readonly store: LeadRowStore,
		@Inject(LG_SEND_STATE) private readonly loadState: SendStateLoader,
		@Inject(LG_DECISION_CLOCK) private readonly clock: DecisionClock,
	) {}

	status(email: string | null): DecisionStatus {
		const policy = readDecisionPolicy(process.env);
		const write = this.store.writeConfig();
		return {
			youAreApprover: isDecisionApprover(email, policy),
			approversConfigured: policy.approvers.length > 0,
			writeConfigured: write.ok,
			writeProblem: write.ok ? null : write.reason,
			tokenSource: write.ok ? write.source : null,
		};
	}

	async decide(input: DecideInput): Promise<DecisionResult> {
		this.authorize(input.actor);
		const replayed = await this.replayOf(input.requestId, input.actor);
		if (replayed) return replayed;
		const target = await this.targetOf(input.leadId);
		const arms = armsSending(target.pool, input.stage, input.decision);
		if (arms && !input.confirmArm)
			throw new BadRequestException(
				"Approving at review makes this lead eligible for the next send. Confirm it first.",
			);
		const now = this.clock();
		return this.execute({
			action: "DECISION",
			requestId: input.requestId,
			actor: input.actor,
			target,
			seen: input.seen,
			stage: input.stage,
			decision: input.decision,
			notes: null,
			arms,
			patch: buildDecisionPatch({
				rowId: target.rowId,
				pool: target.pool,
				stage: input.stage,
				decision: input.decision,
				now,
			}),
			now,
		});
	}

	async rework(input: ReworkInput): Promise<DecisionResult> {
		this.authorize(input.actor);
		const replayed = await this.replayOf(input.requestId, input.actor);
		if (replayed) return replayed;
		const target = await this.targetOf(input.leadId);
		const now = this.clock();
		const built = buildReworkPatch({
			rowId: target.rowId,
			pool: target.pool,
			notes: input.notes,
			now,
		});
		if (!built.ok) throw new BadRequestException(built.reason);
		return this.execute({
			action: "REWORK",
			requestId: input.requestId,
			actor: input.actor,
			target,
			seen: input.seen,
			stage: null,
			decision: null,
			notes: input.notes.trim(),
			arms: false,
			patch: built.patch,
			now,
		});
	}

	private authorize(actor: Actor): void {
		const policy = readDecisionPolicy(process.env);
		if (policy.approvers.length === 0)
			throw new ForbiddenException(
				"Lead decisions are switched off (LEADGEN_DECISION_APPROVERS is not set).",
			);
		if (!isDecisionApprover(actor.email, policy))
			throw new ForbiddenException(
				"This account is not an approved decision maker.",
			);
		const write = this.store.writeConfig();
		if (!write.ok)
			throw new ServiceUnavailableException(
				`Lead decisions cannot be saved: ${write.reason}.`,
			);
	}

	private async replayOf(
		requestId: string,
		actor: Actor,
	): Promise<DecisionResult | null> {
		const prior = await this.db.lgLeadDecision.findUnique({
			where: { requestId },
		});
		if (!prior) return null;
		if (prior.actorId !== actor.id)
			throw new ConflictException("This request id belongs to another user.");
		if (prior.status === "APPLIED" && prior.result) {
			return {
				...(prior.result as Omit<DecisionResult, "replay">),
				replay: true,
			};
		}
		if (prior.status === "FAILED")
			throw new ConflictException(
				"This request already failed. Nothing was saved. Reload the lead and submit again.",
			);
		throw new ConflictException(
			"This request is still in progress or its result is unknown. Do not retry. Reload the lead and check its state.",
		);
	}

	private async targetOf(leadId: string): Promise<Target> {
		const lead = await this.db.lgLead.findFirst({
			where: { id: leadId, mirrorMissingAt: null },
			select: { id: true, nocodbTable: true, nocodbRowId: true },
		});
		if (!lead) throw new NotFoundException("Lead not found in the mirror.");
		const pool = poolOfTable(lead.nocodbTable);
		if (!pool || lead.nocodbRowId === null || !lead.nocodbTable)
			throw new ConflictException("This lead is not tied to a NocoDB row.");
		return {
			leadId: lead.id,
			pool,
			tableId: lead.nocodbTable,
			rowId: lead.nocodbRowId,
		};
	}

	private async execute(plan: Plan): Promise<DecisionResult> {
		const { leadId } = plan.target;
		if (this.inflight.has(leadId))
			throw new ConflictException(
				"Another change to this lead is being saved. Wait a moment and reload.",
			);
		this.inflight.add(leadId);
		try {
			return await this.guardedWrite(plan);
		} finally {
			this.inflight.delete(leadId);
		}
	}

	private async guardedWrite(plan: Plan): Promise<DecisionResult> {
		await this.assertNoRecentPending(plan.target.leadId, plan.now);
		const live = await this.readLive(plan.target);
		await this.assertColumn(plan.target);
		this.assertFresh(plan.seen, live);
		await this.assertAllowed(plan, live);
		const audit = await this.recordAttempt(plan, live);
		try {
			await this.store.patchRow(plan.target.tableId, plan.patch);
		} catch (e) {
			return this.writeFailed(audit, e);
		}
		return this.confirm(plan, audit);
	}

	private async assertNoRecentPending(leadId: string, now: Date) {
		const since = new Date(now.getTime() - RECENT_PENDING_MS);
		const pending = await this.db.lgLeadDecision.findFirst({
			where: { leadId, status: "PENDING", createdAt: { gte: since } },
			select: { id: true },
		});
		if (pending)
			throw new ConflictException(
				"Another change to this lead is being saved. Wait a moment and reload.",
			);
	}

	private async readLive(target: Target): Promise<LiveRow> {
		let live: LiveRow | null;
		try {
			live = await this.store.getRow(target.tableId, target.rowId);
		} catch {
			throw new BadGatewayException(
				"Could not read the lead from NocoDB. Nothing was saved.",
			);
		}
		if (!live)
			throw new ConflictException(
				"The lead no longer exists in NocoDB. Nothing was saved.",
			);
		return live;
	}

	private async assertColumn(target: Target): Promise<void> {
		if (!target.pool.supportsSendApproved) return;
		const state = await this.store.columnState(
			target.tableId,
			SEND_APPROVED_FIELD,
		);
		if (state === "present") return;
		throw new ServiceUnavailableException(
			state === "absent"
				? `Send gate not armed: the '${SEND_APPROVED_FIELD}' column is missing from the ${target.pool.label} NocoDB table, and NocoDB discards writes to a missing column silently. Add it (Checkbox) and try again. Nothing was saved.`
				: `Could not confirm that the '${SEND_APPROVED_FIELD}' column exists in the ${target.pool.label} NocoDB table. Nothing was saved.`,
		);
	}

	private assertFresh(seen: Seen, live: LiveRow): void {
		const stale = staleFields(seen, live);
		if (stale.length === 0) return;
		throw new ConflictException(
			`This lead changed since the page loaded (${stale.join(", ")}). Nothing was saved. Reload and review it again.`,
		);
	}

	private async assertAllowed(plan: Plan, live: LiveRow): Promise<void> {
		const blockers = statusBlockers({ decision: plan.decision, live });
		if (blockers.length === 0 && plan.arms) {
			blockers.push(...(await this.armingProblems(plan, live)));
		}
		if (blockers.length > 0)
			throw new ConflictException(`Not saved: ${blockers.join("; ")}.`);
	}

	private async armingProblems(plan: Plan, live: LiveRow): Promise<string[]> {
		const email =
			typeof live.Email === "string" ? live.Email.trim().toLowerCase() : "";
		const mailed: NocoRow[] = [];
		if (email) {
			const rows = await this.db.lgLead.findMany({
				where: {
					nocodbTable: plan.target.tableId,
					mirrorMissingAt: null,
					sentAt: { not: null },
					nocodbRowId: { not: plan.target.rowId },
					email: { equals: email, mode: "insensitive" },
				},
				select: { raw: true },
			});
			for (const r of rows) {
				if (r.raw && typeof r.raw === "object" && !Array.isArray(r.raw))
					mailed.push(r.raw as NocoRow);
			}
		}
		const state = await this.loadState(plan.now);
		return armingBlockers(live, { mailed, state });
	}

	private async recordAttempt(plan: Plan, live: LiveRow) {
		const prev = versionOf(live);
		const hasFlag = plan.target.pool.supportsSendApproved;
		try {
			return await this.db.lgLeadDecision.create({
				data: {
					requestId: plan.requestId,
					action: plan.action,
					actorId: plan.actor.id,
					actorEmail: plan.actor.email,
					leadId: plan.target.leadId,
					nocodbTable: plan.target.tableId,
					nocodbRowId: plan.target.rowId,
					stage: plan.stage,
					decision: plan.decision,
					notes: plan.notes,
					prevDecision: prev.decision,
					prevSendApproved: hasFlag ? flagOf(live[SEND_APPROVED_FIELD]) : null,
					prevVersion: prev.updatedAt,
					patch: plan.patch as Prisma.InputJsonValue,
					status: "PENDING",
				},
			});
		} catch (e) {
			if ((e as { code?: string }).code === "P2002")
				throw new ConflictException("This request is already being handled.");
			this.logger.error({ message: "audit row could not be written" });
			throw new InternalServerErrorException(
				"The change could not be recorded, so nothing was saved.",
			);
		}
	}

	private async writeFailed(
		audit: { id: string },
		error: unknown,
	): Promise<never> {
		const definite =
			error instanceof NocoWriteError && error.kind === "rejected";
		const why = error instanceof Error ? error.message : "write failed";
		await this.finish(audit.id, definite ? "FAILED" : "UNKNOWN", why, null);
		if (definite)
			throw new BadGatewayException(
				`NocoDB refused the change (${why}). Nothing was saved.`,
			);
		this.logger.error({ message: "ambiguous NocoDB write", auditId: audit.id });
		throw new InternalServerErrorException(
			"The result of the save is unknown. It may or may not have gone through. Do not retry blindly: reload the lead and check its state.",
		);
	}

	private async confirm(
		plan: Plan,
		audit: { id: string },
	): Promise<DecisionResult> {
		let after: LiveRow | null = null;
		try {
			after = await this.store.getRow(plan.target.tableId, plan.target.rowId);
		} catch {
			after = null;
		}
		if (!after) {
			await this.finish(audit.id, "UNKNOWN", "saved, read-back failed", null);
			throw new InternalServerErrorException(
				"NocoDB accepted the change but it could not be read back. Reload the lead and check its state.",
			);
		}
		const wrong = verifyPatch(plan.patch, after);
		if (wrong.length > 0) {
			await this.finish(
				audit.id,
				"UNKNOWN",
				`read-back mismatch: ${wrong.join(", ")}`,
				null,
			);
			throw new InternalServerErrorException(
				`NocoDB did not keep the change (${wrong.join(", ")}). Check the lead in NocoDB before trying again.`,
			);
		}
		const result = this.resultOf(audit.id, plan, after);
		await this.finish(audit.id, "APPLIED", "applied and verified", result);
		return result;
	}

	private resultOf(
		auditId: string,
		plan: Plan,
		after: LiveRow,
	): DecisionResult {
		const now = versionOf(after);
		const rework = after["Rework Requested"];
		return {
			auditId,
			replay: false,
			leadId: plan.target.leadId,
			action: plan.action,
			decision: now.decision,
			sendApproved: plan.target.pool.supportsSendApproved
				? flagOf(after[SEND_APPROVED_FIELD])
				: null,
			decisionDate: now.decisionDate,
			version: now.updatedAt === "" ? null : now.updatedAt,
			reworkRequested: typeof rework === "string" && rework.trim() !== "",
			appliedAt: this.clock().toISOString(),
		};
	}

	private async finish(
		id: string,
		status: "APPLIED" | "FAILED" | "UNKNOWN",
		outcome: string,
		result: DecisionResult | null,
	): Promise<void> {
		try {
			await this.db.lgLeadDecision.update({
				where: { id },
				data: {
					status,
					outcome: outcome.slice(0, 300),
					result: result ? (result as Prisma.InputJsonValue) : undefined,
					completedAt: this.clock(),
				},
			});
		} catch {
			this.logger.error({
				message: "audit outcome could not be written",
				auditId: id,
				status,
			});
		}
	}
}

export const defaultDecisionClock: DecisionClock = () => new Date();
