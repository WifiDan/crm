import { Module } from "@nestjs/common";
import { TrpcModule } from "../trpc/trpc.module";
import { LG_JOB_HANDLERS } from "./job-handler";
import { LgJobSchedulerService } from "./job-scheduler.service";
import { LeadgenRouter } from "./leadgen.router";
import { LeadgenSeedService } from "./leadgen.seed";
import { LeadgenService } from "./leadgen.service";
import { NocodbMirrorHandler } from "./nocodb-mirror.handler";
import { OutreachCompareHandler } from "./outreach-compare.handler";
import { OutreachShadowHandler } from "./outreach-shadow.handler";
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

@Module({
	imports: [TrpcModule],
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
	],
	exports: [LgJobSchedulerService, LeadgenService],
})
export class LeadgenModule {}
