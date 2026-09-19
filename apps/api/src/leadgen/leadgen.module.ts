import { Module } from "@nestjs/common";
import { TrpcModule } from "../trpc/trpc.module";
import { LG_JOB_HANDLERS } from "./job-handler";
import { LgJobSchedulerService } from "./job-scheduler.service";
import { LeadgenRouter } from "./leadgen.router";
import { LeadgenSeedService } from "./leadgen.seed";
import { LeadgenService } from "./leadgen.service";
import { NocodbMirrorHandler } from "./nocodb-mirror.handler";

@Module({
	imports: [TrpcModule],
	providers: [
		NocodbMirrorHandler,
		{
			provide: LG_JOB_HANDLERS,
			useFactory: (mirror: NocodbMirrorHandler) => [mirror],
			inject: [NocodbMirrorHandler],
		},
		LgJobSchedulerService,
		LeadgenService,
		LeadgenSeedService,
		LeadgenRouter,
	],
	exports: [LgJobSchedulerService, LeadgenService],
})
export class LeadgenModule {}
