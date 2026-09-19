import { Module } from "@nestjs/common";
import { TrpcModule } from "../trpc/trpc.module";
import { LG_JOB_HANDLERS } from "./job-handler";
import { LgJobSchedulerService } from "./job-scheduler.service";
import { LeadgenRouter } from "./leadgen.router";
import { LeadgenSeedService } from "./leadgen.seed";
import { LeadgenService } from "./leadgen.service";
import { NocodbMirrorHandler } from "./nocodb-mirror.handler";
import { RepliesDraftHandler } from "./replies-draft.handler";
import { RepliesPollHandler } from "./replies-poll.handler";
import { SendlogSyncHandler } from "./sendlog-sync.handler";

@Module({
	imports: [TrpcModule],
	providers: [
		NocodbMirrorHandler,
		SendlogSyncHandler,
		RepliesPollHandler,
		RepliesDraftHandler,
		{
			provide: LG_JOB_HANDLERS,
			useFactory: (
				mirror: NocodbMirrorHandler,
				sendlog: SendlogSyncHandler,
				replies: RepliesPollHandler,
				drafts: RepliesDraftHandler,
			) => [mirror, sendlog, replies, drafts],
			inject: [
				NocodbMirrorHandler,
				SendlogSyncHandler,
				RepliesPollHandler,
				RepliesDraftHandler,
			],
		},
		LgJobSchedulerService,
		LeadgenService,
		LeadgenSeedService,
		LeadgenRouter,
	],
	exports: [LgJobSchedulerService, LeadgenService],
})
export class LeadgenModule {}
