import { Module } from "@nestjs/common";
import { TrpcModule } from "../trpc/trpc.module";
import {
	defaultDemoDirs,
	LG_DEMO_CLOCK,
	LG_DEMO_DIRS,
	LG_PREVIEW_KEY,
} from "./demo-edit.config";
import { DemoEditRouter } from "./demo-edit.router";
import { DemoEditService } from "./demo-edit.service";
import { DemoPreviewController } from "./demo-preview.controller";
import { DemoPreviewService, newPreviewKey } from "./demo-preview.service";
import { LG_JOB_HANDLERS } from "./job-handler";
import { LgJobSchedulerService } from "./job-scheduler.service";
import { LeadDecisionRouter } from "./lead-decision.router";
import {
	defaultDecisionClock,
	LeadDecisionService,
	LG_DECISION_CLOCK,
	LG_SEND_STATE,
} from "./lead-decision.service";
import { LG_LEAD_STORE, nocodbLeadStore } from "./lead-decision.store";
import { LeadgenViewsService } from "./lead-views.service";
import { LeadgenRouter } from "./leadgen.router";
import { LeadgenSeedService } from "./leadgen.seed";
import { LeadgenService } from "./leadgen.service";
import { NocodbMirrorHandler } from "./nocodb-mirror.handler";
import { LeadgenOpsService } from "./ops.service";
import { OutreachCompareHandler } from "./outreach-compare.handler";
import { OutreachShadowHandler } from "./outreach-shadow.handler";
import { PrewarmRouter } from "./prewarm.router";
import { LeadgenPrewarmService } from "./prewarm.service";
import { loadPythonSendState } from "./python-state";
import { RepliesDraftHandler } from "./replies-draft.handler";
import { RepliesPollHandler } from "./replies-poll.handler";
import { ReplyApprovalRouter } from "./reply-approval.router";
import { ReplyApprovalService } from "./reply-approval.service";
import { identityFromEnv, LG_REPLY_IDENTITY } from "./reply-identity";
import {
	LG_REPLY_TRANSPORT,
	ReplySendService,
	smtpTransportFromEnv,
} from "./reply-send.service";
import { SendlogSyncHandler } from "./sendlog-sync.handler";
import { ShotController } from "./shot.controller";
import { ShotRouter } from "./shot.router";
import {
	defaultShotEnv,
	LeadgenShotService,
	LG_SHOT_ENV,
} from "./shot.service";
import { SiteAuditRouter } from "./site-audit.router";
import {
	defaultAuditEnv,
	LG_AUDIT_ENV,
	SiteAuditService,
} from "./site-audit.service";

@Module({
	imports: [TrpcModule],
	controllers: [DemoPreviewController, ShotController],
	providers: [
		NocodbMirrorHandler,
		SendlogSyncHandler,
		RepliesPollHandler,
		RepliesDraftHandler,
		OutreachShadowHandler,
		OutreachCompareHandler,
		{
			provide: LG_JOB_HANDLERS,
			useFactory: (
				mirror: NocodbMirrorHandler,
				sendlog: SendlogSyncHandler,
				replies: RepliesPollHandler,
				drafts: RepliesDraftHandler,
				shadow: OutreachShadowHandler,
				compare: OutreachCompareHandler,
			) => [mirror, sendlog, replies, drafts, shadow, compare],
			inject: [
				NocodbMirrorHandler,
				SendlogSyncHandler,
				RepliesPollHandler,
				RepliesDraftHandler,
				OutreachShadowHandler,
				OutreachCompareHandler,
			],
		},
		LgJobSchedulerService,
		LeadgenService,
		LeadgenViewsService,
		LeadgenOpsService,
		LeadgenSeedService,
		LeadgenRouter,
		{
			provide: LG_REPLY_IDENTITY,
			useFactory: () => identityFromEnv(process.env),
		},
		{
			provide: LG_REPLY_TRANSPORT,
			useFactory: () => smtpTransportFromEnv(process.env),
		},
		ReplySendService,
		ReplyApprovalService,
		ReplyApprovalRouter,
		{
			provide: LG_LEAD_STORE,
			useFactory: () => nocodbLeadStore(process.env),
		},
		{
			provide: LG_SEND_STATE,
			useFactory: () => loadPythonSendState,
		},
		{ provide: LG_DECISION_CLOCK, useValue: defaultDecisionClock },
		LeadDecisionService,
		LeadDecisionRouter,
		{ provide: LG_AUDIT_ENV, useFactory: () => defaultAuditEnv(process.env) },
		SiteAuditService,
		SiteAuditRouter,
		{ provide: LG_DEMO_DIRS, useFactory: () => defaultDemoDirs(process.env) },
		{ provide: LG_PREVIEW_KEY, useFactory: newPreviewKey },
		{ provide: LG_DEMO_CLOCK, useValue: () => new Date() },
		DemoPreviewService,
		DemoEditService,
		DemoEditRouter,
		{ provide: LG_SHOT_ENV, useFactory: () => defaultShotEnv(process.env) },
		LeadgenShotService,
		ShotRouter,
		LeadgenPrewarmService,
		PrewarmRouter,
	],
	exports: [LgJobSchedulerService, LeadgenService],
})
export class LeadgenModule {}
