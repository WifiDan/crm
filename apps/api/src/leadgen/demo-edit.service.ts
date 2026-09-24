import { readdir } from "node:fs/promises";
import { type Db, type Prisma } from "@crm/db";
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Inject,
	Injectable,
	InternalServerErrorException,
	Logger,
	NotFoundException,
	PayloadTooLargeException,
} from "@nestjs/common";
import type { z } from "zod";
import { InjectDatabase } from "../database/database.constants";
import {
	DEPLOY_HINT,
	type DemoClock,
	type DemoDirs,
	LG_DEMO_CLOCK,
	LG_DEMO_DIRS,
} from "./demo-edit.config";
import type {
	demoInfoOutput,
	previewOutput,
	saveOutput,
} from "./demo-edit.contracts";
import {
	assertBackupOutsideOutput,
	commitSave,
	DEMO_LIMITS,
	DemoFileError,
	prepareSave,
	readDemoIndex,
	resolveDemoDir,
} from "./demo-files";
import { DemoPreviewService } from "./demo-preview.service";
import { isDecisionApprover, readDecisionPolicy } from "./lead-decision.rules";
import { slugFromDemoUrl } from "./lead-view";
import { resolveBuildDir } from "./site-builds";

export type EditActor = { id: string; email: string | null };

export type DemoInfo = z.infer<typeof demoInfoOutput>;
export type PreviewLink = z.infer<typeof previewOutput>;
export type SaveResult = z.infer<typeof saveOutput>;

export type SaveInput = {
	leadId: string;
	requestId: string;
	html: string;
	baseSha256: string;
	actor: EditActor;
};

type Located = { slug: string; dir: string };

const RECENT_PENDING_MS = 120_000;

@Injectable()
export class DemoEditService {
	private readonly logger = new Logger(DemoEditService.name);
	private readonly inflight = new Set<string>();

	constructor(
		@InjectDatabase() private readonly db: Db,
		@Inject(LG_DEMO_DIRS) private readonly dirs: DemoDirs,
		@Inject(LG_DEMO_CLOCK) private readonly clock: DemoClock,
		@Inject(DemoPreviewService) private readonly previews: DemoPreviewService,
	) {}

	private editProblem(email: string | null): string | null {
		const policy = readDecisionPolicy(process.env);
		if (policy.approvers.length === 0)
			return "Demo editing is switched off (LEADGEN_DECISION_APPROVERS is not set).";
		if (!isDecisionApprover(email, policy))
			return "This account is not an approved decision maker.";
		return null;
	}

	private authorize(actor: EditActor): void {
		const problem = this.editProblem(actor.email);
		if (problem) throw new ForbiddenException(problem);
	}

	private async slugOf(leadId: string): Promise<string | null> {
		const lead = await this.db.lgLead.findFirst({
			where: { id: leadId, mirrorMissingAt: null },
			select: { demoUrl: true },
		});
		if (!lead) throw new NotFoundException("Lead not found in the mirror.");
		const parsed = slugFromDemoUrl(lead.demoUrl);
		if (!parsed) return null;
		const names = await readdir(this.dirs.outputDir).catch(
			() => [] as string[],
		);
		return resolveBuildDir(parsed, names);
	}

	private async locate(leadId: string): Promise<Located> {
		const slug = await this.slugOf(leadId);
		if (!slug)
			throw new NotFoundException("This lead has no local demo build.");
		try {
			return { slug, dir: await resolveDemoDir(this.dirs.outputDir, slug) };
		} catch (e) {
			if (e instanceof DemoFileError)
				throw new NotFoundException(`No local copy: ${e.message}.`);
			throw e;
		}
	}

	async info(leadId: string, email: string | null): Promise<DemoInfo> {
		const problem = this.editProblem(email);
		const base = {
			canEdit: problem === null,
			editProblem: problem,
			keepBackups: DEMO_LIMITS.keepBackups,
		};
		const empty = (slug: string | null, reason: string): DemoInfo => ({
			hasLocal: false,
			slug,
			reason,
			bytes: null,
			sha256: null,
			modifiedAt: null,
			lastEdit: null,
			deployHint: null,
			...base,
		});
		const slug = await this.slugOf(leadId);
		if (!slug) return empty(null, "No local build folder matches this lead.");
		let dir: string;
		try {
			dir = await resolveDemoDir(this.dirs.outputDir, slug);
		} catch (e) {
			return empty(
				slug,
				e instanceof DemoFileError ? e.message : "unavailable",
			);
		}
		const index = await readDemoIndex(dir);
		const last = await this.db.lgDemoEdit.findFirst({
			where: { leadId },
			orderBy: { createdAt: "desc" },
		});
		return {
			hasLocal: true,
			slug,
			reason: null,
			bytes: index.bytes,
			sha256: index.sha256,
			modifiedAt: index.modifiedAt.toISOString(),
			lastEdit: last
				? {
						at: last.createdAt.toISOString(),
						by: last.actorEmail,
						bytes: last.bytesAfter,
						backupName: last.backupName,
						status: last.status,
					}
				: null,
			deployHint: DEPLOY_HINT(slug),
			...base,
		};
	}

	async previewLink(
		leadId: string,
		edit: boolean,
		actor: EditActor,
	): Promise<PreviewLink> {
		if (edit) this.authorize(actor);
		const { slug, dir } = await this.locate(leadId);
		const index = await readDemoIndex(dir);
		return {
			...this.previews.mint(slug, edit ? "edit" : "view"),
			sha256: index.sha256,
		};
	}

	async save(input: SaveInput): Promise<SaveResult> {
		this.authorize(input.actor);
		const replay = await this.replayOf(input.requestId, input.actor);
		if (replay) return replay;
		const { slug, dir } = await this.locate(input.leadId);
		if (this.inflight.has(slug))
			throw new ConflictException(
				"Another save of this demo is in progress. Wait a moment and reload.",
			);
		this.inflight.add(slug);
		try {
			return await this.guardedSave(input, slug, dir);
		} finally {
			this.inflight.delete(slug);
		}
	}

	private async replayOf(
		requestId: string,
		actor: EditActor,
	): Promise<SaveResult | null> {
		const prior = await this.db.lgDemoEdit.findUnique({ where: { requestId } });
		if (!prior) return null;
		if (prior.actorId !== actor.id)
			throw new ConflictException("This request id belongs to another user.");
		if (prior.status === "APPLIED" && prior.result)
			return { ...(prior.result as Omit<SaveResult, "replay">), replay: true };
		if (prior.status === "FAILED")
			throw new ConflictException(
				"This request already failed. Nothing was saved. Reload the demo and submit again.",
			);
		throw new ConflictException(
			"This request is still in progress or its result is unknown. Do not retry. Reload the demo and check the file.",
		);
	}

	private async guardedSave(
		input: SaveInput,
		slug: string,
		dir: string,
	): Promise<SaveResult> {
		const now = this.clock();
		await this.assertNoRecentPending(slug, now);
		try {
			await assertBackupOutsideOutput(this.dirs.outputDir, this.dirs.backupDir);
		} catch (e) {
			this.logger.error({ message: "backup folder is unsafe" });
			throw new InternalServerErrorException(
				e instanceof DemoFileError ? e.message : "backup folder is unusable",
			);
		}
		const prepared = await prepareSave({
			dir,
			html: input.html,
			expectedSha256: input.baseSha256,
			now,
		}).catch((e) => {
			throw this.refusal(e);
		});
		const audit = await this.recordAttempt(input, prepared);
		try {
			await commitSave(prepared, this.dirs.backupDir);
		} catch (e) {
			return this.writeFailed(audit.id, dir, prepared.before.sha256, e);
		}
		return this.confirm(audit.id, dir, prepared, now);
	}

	private refusal(e: unknown): Error {
		if (!(e instanceof DemoFileError)) return e as Error;
		if (e.code === "stale")
			return new ConflictException(
				`${e.message}. Reload and edit again. Nothing was saved.`,
			);
		if (e.code === "too-large") return new PayloadTooLargeException(e.message);
		return new BadRequestException(e.message);
	}

	private async assertNoRecentPending(slug: string, now: Date) {
		const since = new Date(now.getTime() - RECENT_PENDING_MS);
		const pending = await this.db.lgDemoEdit.findFirst({
			where: { slug, status: "PENDING", createdAt: { gte: since } },
			select: { id: true },
		});
		if (pending)
			throw new ConflictException(
				"Another save of this demo is in progress. Wait a moment and reload.",
			);
	}

	private async recordAttempt(
		input: SaveInput,
		p: Awaited<ReturnType<typeof prepareSave>>,
	) {
		try {
			return await this.db.lgDemoEdit.create({
				data: {
					requestId: input.requestId,
					actorId: input.actor.id,
					actorEmail: input.actor.email,
					leadId: input.leadId,
					slug: p.slug,
					bytesBefore: p.before.bytes,
					sha256Before: p.before.sha256,
					bytesAfter: p.after.bytes,
					sha256After: p.after.sha256,
					backupName: p.backupName,
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
		auditId: string,
		dir: string,
		shaBefore: string,
		error: unknown,
	): Promise<never> {
		const now = await readDemoIndex(dir).catch(() => null);
		const unchanged = now?.sha256 === shaBefore;
		const why = error instanceof Error ? error.message : "write failed";
		await this.finish(auditId, unchanged ? "FAILED" : "UNKNOWN", why, null);
		if (unchanged)
			throw new InternalServerErrorException(
				"The demo could not be written. The file is unchanged.",
			);
		throw new InternalServerErrorException(
			"The result of the save is unknown. Reload the demo and check the file. Do not retry blindly.",
		);
	}

	private async confirm(
		auditId: string,
		dir: string,
		p: Awaited<ReturnType<typeof prepareSave>>,
		now: Date,
	): Promise<SaveResult> {
		const after = await readDemoIndex(dir).catch(() => null);
		if (!after || after.sha256 !== p.after.sha256) {
			await this.finish(auditId, "UNKNOWN", "read-back mismatch", null);
			throw new InternalServerErrorException(
				"The demo file does not match what was saved. Reload it and check before trying again.",
			);
		}
		const result: SaveResult = {
			auditId,
			replay: false,
			slug: p.slug,
			bytes: p.after.bytes,
			sha256: p.after.sha256,
			backupName: p.backupName,
			savedAt: now.toISOString(),
			live: false,
		};
		await this.finish(
			auditId,
			"APPLIED",
			"saved locally, not published",
			result,
		);
		return result;
	}

	private async finish(
		id: string,
		status: "APPLIED" | "FAILED" | "UNKNOWN",
		outcome: string,
		result: SaveResult | null,
	): Promise<void> {
		try {
			await this.db.lgDemoEdit.update({
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
