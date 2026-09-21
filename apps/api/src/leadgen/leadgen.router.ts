import { Inject } from "@nestjs/common";
import {
	Ctx,
	Input,
	Mutation,
	Query,
	Router,
	UseMiddlewares,
} from "nestjs-trpc";
import type { z } from "zod";
import type { AuthedTrpcContext } from "../trpc/context.types";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import { restMeta } from "../trpc/openapi";
import { LgJobSchedulerService } from "./job-scheduler.service";
import {
	leadDetailInput,
	leadDetailOutput,
	reviewListInput,
	reviewListOutput,
	triageListInput,
	triageListOutput,
} from "./lead-views.contracts";
import { LeadgenViewsService } from "./lead-views.service";
import {
	alertListOutput,
	jobListOutput,
	jobNameInput,
	jobRunNowOutput,
	jobRunsInput,
	jobRunsOutput,
	jobSetEnabledInput,
	leadsListInput,
	leadsListOutput,
	marketListOutput,
	mirrorStatusOutput,
	okOutput,
} from "./leadgen.contracts";
import { LeadgenService } from "./leadgen.service";
import {
	opsCallListInput,
	opsCallListOutput,
	opsHealthOutput,
	opsOverviewOutput,
	opsRecentSendsInput,
	opsRecentSendsOutput,
} from "./ops.contracts";
import { LeadgenOpsService } from "./ops.service";

@Router({ alias: "leadgen" })
@UseMiddlewares(AuthMiddleware)
export class LeadgenRouter {
	constructor(
		@Inject(LeadgenService) private readonly leadgen: LeadgenService,
		@Inject(LgJobSchedulerService)
		private readonly scheduler: LgJobSchedulerService,
		@Inject(LeadgenViewsService) private readonly views: LeadgenViewsService,
		@Inject(LeadgenOpsService) private readonly ops: LeadgenOpsService,
	) {}

	@Query({
		output: jobListOutput,
		meta: restMeta("GET", "/leadgen/jobs", ["Leadgen"]),
	})
	async jobs() {
		return this.leadgen.listJobs();
	}

	@Query({
		input: jobRunsInput,
		output: jobRunsOutput,
		meta: restMeta("GET", "/leadgen/job-runs", ["Leadgen"]),
	})
	async jobRuns(@Input() input: z.infer<typeof jobRunsInput>) {
		return this.leadgen.listRuns(input.name, input.limit);
	}

	@Mutation({
		input: jobNameInput,
		output: jobRunNowOutput,
		meta: restMeta("POST", "/leadgen/jobs/run-now", ["Leadgen"]),
	})
	async jobRunNow(
		@Ctx() _ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof jobNameInput>,
	) {
		return this.scheduler.runNow(input.name);
	}

	@Mutation({
		input: jobSetEnabledInput,
		output: okOutput,
		meta: restMeta("POST", "/leadgen/jobs/enabled", ["Leadgen"]),
	})
	async jobSetEnabled(@Input() input: z.infer<typeof jobSetEnabledInput>) {
		return { ok: await this.leadgen.setEnabled(input.name, input.enabled) };
	}

	@Query({
		output: alertListOutput,
		meta: restMeta("GET", "/leadgen/alerts", ["Leadgen"]),
	})
	async alerts() {
		return this.leadgen.listAlerts();
	}

	@Query({
		output: marketListOutput,
		meta: restMeta("GET", "/leadgen/markets", ["Leadgen"]),
	})
	async markets() {
		return this.leadgen.listMarkets();
	}

	@Query({
		input: leadsListInput,
		output: leadsListOutput,
		meta: restMeta("POST", "/leadgen/leads/search", ["Leadgen"]),
	})
	async leads(@Input() input: z.infer<typeof leadsListInput>) {
		return this.leadgen.listLeads(input);
	}

	@Query({
		output: mirrorStatusOutput,
		meta: restMeta("GET", "/leadgen/mirror-status", ["Leadgen"]),
	})
	async mirrorStatus() {
		return this.leadgen.mirrorStatus();
	}

	@Query({
		input: triageListInput,
		output: triageListOutput,
		meta: restMeta("POST", "/leadgen/triage/search", ["Leadgen"]),
	})
	async triageList(@Input() input: z.infer<typeof triageListInput>) {
		return this.views.triageList(input);
	}

	@Query({
		input: reviewListInput,
		output: reviewListOutput,
		meta: restMeta("POST", "/leadgen/review/search", ["Leadgen"]),
	})
	async reviewList(@Input() input: z.infer<typeof reviewListInput>) {
		return this.views.reviewList(input);
	}

	@Query({
		input: leadDetailInput,
		output: leadDetailOutput,
		meta: restMeta("POST", "/leadgen/lead-detail", ["Leadgen"]),
	})
	async leadDetail(@Input() input: z.infer<typeof leadDetailInput>) {
		return this.views.leadDetail(input.id);
	}

	@Query({
		output: opsOverviewOutput,
		meta: restMeta("GET", "/leadgen/ops/overview", ["Leadgen"]),
	})
	async opsOverview() {
		return this.ops.overview();
	}

	@Query({
		output: opsHealthOutput,
		meta: restMeta("GET", "/leadgen/ops/health", ["Leadgen"]),
	})
	async opsHealth() {
		return this.ops.health();
	}

	@Query({
		input: opsCallListInput,
		output: opsCallListOutput,
		meta: restMeta("POST", "/leadgen/ops/call-list", ["Leadgen"]),
	})
	async opsCallList(@Input() input: z.infer<typeof opsCallListInput>) {
		return this.ops.callList(input);
	}

	@Query({
		input: opsRecentSendsInput,
		output: opsRecentSendsOutput,
		meta: restMeta("POST", "/leadgen/ops/recent-sends", ["Leadgen"]),
	})
	async opsRecentSends(@Input() input: z.infer<typeof opsRecentSendsInput>) {
		return this.ops.recentSends(input);
	}
}
