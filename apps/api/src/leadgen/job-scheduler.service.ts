import { type Db, Prisma as PrismaNamespace } from "@crm/db";
import {
	Inject,
	Injectable,
	Logger,
	type OnApplicationShutdown,
	type OnModuleInit,
} from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { LG_JOB_HANDLERS, type LgJobHandler } from "./job-handler";
import { nextRunAfter } from "./schedule";

const TICK_MS = 30_000;
const LEASE_GRACE_SECONDS = 60;

class JobTimeoutError extends Error {
	constructor(jobName: string, seconds: number) {
		super(`job "${jobName}" exceeded its ${seconds}s timeout`);
	}
}

type ClaimedJob = {
	def: { id: string; name: string; timeoutSeconds: number };
	runId: string;
};

/**
 * Durable scheduler for the lead-gen jobs. One ticker; state lives in Postgres
 * (lg_job_definition / lg_job_run), so a restart or a crash loses nothing.
 *
 * The invariant that matters: every execution leaves an lg_job_run row BEFORE
 * any work starts. A job that dies leaves a RUNNING row with an expired lease;
 * the next tick marks it TIMED_OUT and raises a PAGE alert. Silence therefore
 * shows up as data instead of as an absence nobody notices.
 *
 * Off by default (LEADGEN_SCHEDULER_ENABLED=true turns the ticker on) so that
 * deploying this code never starts anything by itself.
 */
@Injectable()
export class LgJobSchedulerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(LgJobSchedulerService.name);
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticking = false;
	private readonly handlers = new Map<string, LgJobHandler>();

	constructor(
		@InjectDatabase() private readonly db: Db,
		@Inject(LG_JOB_HANDLERS) handlers: LgJobHandler[],
	) {
		for (const h of handlers) this.handlers.set(h.name, h);
	}

	onModuleInit(): void {
		if (process.env.LEADGEN_SCHEDULER_ENABLED !== "true") {
			this.logger.log({
				message:
					"Lead-gen scheduler disabled (LEADGEN_SCHEDULER_ENABLED != true)",
			});
			return;
		}
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.logger.log({
			message: "Lead-gen scheduler started",
			handlers: [...this.handlers.keys()],
		});
	}

	onApplicationShutdown(): void {
		if (this.timer) clearInterval(this.timer);
	}

	registeredHandlers(): string[] {
		return [...this.handlers.keys()];
	}

	async tick(now = new Date()): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.sweepExpiredLeases(now);
			await this.checkStale(now);
			const claimed = await this.claimDue(now);
			for (const job of claimed) {
				void this.execute(job);
			}
		} catch (error) {
			this.logger.error(
				{ message: "Scheduler tick failed" },
				error instanceof Error ? error.stack : String(error),
			);
		} finally {
			this.ticking = false;
		}
	}

	private async claimDue(now: Date): Promise<ClaimedJob[]> {
		return this.db.$transaction(async (tx) => {
			const due = await tx.$queryRaw<{ id: string }[]>(
				PrismaNamespace.sql`
					SELECT d.id FROM lg_job_definition d
					WHERE d.enabled = true
					  AND d."nextRunAt" IS NOT NULL
					  AND d."nextRunAt" <= ${now}
					  AND NOT EXISTS (
					    SELECT 1 FROM lg_job_run r
					    WHERE r."jobId" = d.id AND r.status = 'RUNNING'
					  )
					ORDER BY d."nextRunAt"
					LIMIT 5
					FOR UPDATE OF d SKIP LOCKED`,
			);
			const claimed: ClaimedJob[] = [];
			for (const { id } of due) {
				const def = await tx.lgJobDefinition.findUniqueOrThrow({
					where: { id },
				});
				const run = await tx.lgJobRun.create({
					data: {
						jobId: id,
						trigger: "schedule",
						leaseExpiresAt: new Date(
							now.getTime() + (def.timeoutSeconds + LEASE_GRACE_SECONDS) * 1000,
						),
					},
				});
				await tx.lgJobDefinition.update({
					where: { id },
					data: { lastRunAt: now, nextRunAt: nextRunAfter(def, now) },
				});
				claimed.push({ def, runId: run.id });
			}
			return claimed;
		});
	}

	/** Manual trigger from the UI. Refuses to overlap a run already in flight. */
	async runNow(
		name: string,
	): Promise<{ started: boolean; runId?: string; reason?: string }> {
		const def = await this.db.lgJobDefinition.findUnique({ where: { name } });
		if (!def) return { started: false, reason: `no job named "${name}"` };
		if (!this.handlers.has(name)) {
			return { started: false, reason: `no handler registered for "${name}"` };
		}
		const running = await this.db.lgJobRun.findFirst({
			where: { jobId: def.id, status: "RUNNING" },
		});
		if (running) {
			return { started: false, reason: "already running", runId: running.id };
		}
		const run = await this.db.lgJobRun.create({
			data: {
				jobId: def.id,
				trigger: "manual",
				leaseExpiresAt: new Date(
					Date.now() + (def.timeoutSeconds + LEASE_GRACE_SECONDS) * 1000,
				),
			},
		});
		void this.execute({ def, runId: run.id });
		return { started: true, runId: run.id };
	}

	private async execute({ def, runId }: ClaimedJob): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			def.timeoutSeconds * 1000,
		);
		try {
			const handler = this.handlers.get(def.name);
			if (!handler) {
				throw new Error(`no handler registered for job "${def.name}"`);
			}
			const result = await Promise.race([
				handler.run({ runId, jobName: def.name, signal: controller.signal }),
				new Promise<never>((_, reject) => {
					controller.signal.addEventListener("abort", () =>
						reject(new JobTimeoutError(def.name, def.timeoutSeconds)),
					);
				}),
			]);
			await this.finalize(runId, "OK", null, result.counters);
			await this.resolveAlert(`job-failed:${def.name}`);
			this.logger.log({
				message: "Job finished",
				job: def.name,
				counters: result.counters,
			});
		} catch (error) {
			const timedOut = error instanceof JobTimeoutError;
			const text = error instanceof Error ? error.message : String(error);
			await this.finalize(runId, timedOut ? "TIMED_OUT" : "FAILED", text, null);
			await this.raiseAlert(
				"PAGE",
				`job-failed:${def.name}`,
				`${def.name} ${timedOut ? "timed out" : "failed"}: ${text}`.slice(
					0,
					500,
				),
				def.id,
			);
			this.logger.error({ message: "Job failed", job: def.name, error: text });
		} finally {
			clearTimeout(timeout);
		}
	}

	private async finalize(
		runId: string,
		status: "OK" | "FAILED" | "TIMED_OUT",
		error: string | null,
		counters: Record<string, number | string> | null,
	): Promise<void> {
		// updateMany + status guard: never overwrite a row the lease sweeper
		// already marked TIMED_OUT.
		await this.db.lgJobRun.updateMany({
			where: { id: runId, status: "RUNNING" },
			data: {
				status,
				finishedAt: new Date(),
				error,
				counters: counters ?? undefined,
			},
		});
	}

	private async sweepExpiredLeases(now: Date): Promise<void> {
		const expired = await this.db.lgJobRun.findMany({
			where: { status: "RUNNING", leaseExpiresAt: { lt: now } },
			include: { job: true },
		});
		for (const run of expired) {
			const swept = await this.db.lgJobRun.updateMany({
				where: { id: run.id, status: "RUNNING" },
				data: {
					status: "TIMED_OUT",
					finishedAt: now,
					error: "lease expired: process died or handler hung",
				},
			});
			if (swept.count > 0) {
				await this.raiseAlert(
					"PAGE",
					`job-failed:${run.job.name}`,
					`${run.job.name} left a RUNNING row past its lease (process died or hung)`,
					run.jobId,
				);
			}
		}
	}

	private async checkStale(now: Date): Promise<void> {
		const defs = await this.db.lgJobDefinition.findMany({
			where: { enabled: true },
		});
		for (const def of defs) {
			const lastOk = await this.db.lgJobRun.findFirst({
				where: { jobId: def.id, status: "OK" },
				orderBy: { finishedAt: "desc" },
			});
			const reference = lastOk?.finishedAt ?? def.createdAt;
			const stale =
				now.getTime() - reference.getTime() > def.maxAgeSeconds * 1000;
			const key = `job-stale:${def.name}`;
			if (stale) {
				await this.raiseAlert(
					"PAGE",
					key,
					`${def.name} has not completed OK in over ${Math.round(def.maxAgeSeconds / 3600)}h`,
					def.id,
				);
			} else {
				await this.resolveAlert(key);
			}
		}
	}

	async raiseAlert(
		tier: "PAGE" | "DIGEST" | "LOG",
		key: string,
		message: string,
		jobId?: string,
	): Promise<void> {
		const open = await this.db.lgAlert.findFirst({
			where: { key, resolvedAt: null },
		});
		if (open) return;
		await this.db.lgAlert.create({ data: { tier, key, message, jobId } });
	}

	async resolveAlert(key: string): Promise<void> {
		await this.db.lgAlert.updateMany({
			where: { key, resolvedAt: null },
			data: { resolvedAt: new Date() },
		});
	}
}
