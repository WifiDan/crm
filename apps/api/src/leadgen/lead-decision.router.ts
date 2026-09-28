import { Inject } from "@nestjs/common";
import { TRPCError } from "@trpc/server";
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
import { SessionOnlyMiddleware } from "../trpc/middlewares/session-only.middleware";
import {
	decideInput,
	decisionResultOutput,
	decisionStatusOutput,
	reworkInput,
} from "./lead-decision.contracts";
import { LeadDecisionService } from "./lead-decision.service";

@Router({ alias: "leadgenDecisions" })
@UseMiddlewares(AuthMiddleware, SessionOnlyMiddleware)
export class LeadDecisionRouter {
	constructor(
		@Inject(LeadDecisionService)
		private readonly decisions: LeadDecisionService,
	) {}

	@Query({ output: decisionStatusOutput })
	async status(@Ctx() ctx: AuthedTrpcContext) {
		return this.decisions.status(ctx.user.email ?? null);
	}

	@Mutation({ input: decideInput, output: decisionResultOutput })
	async decide(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof decideInput>,
	) {
		if (!ctx.user.id) throw new TRPCError({ code: "UNAUTHORIZED" });
		return this.decisions.decide({
			leadId: input.id,
			requestId: input.requestId,
			stage: input.stage,
			decision: input.decision,
			seen: input.seen,
			confirmArm: input.confirmArm,
			actor: { id: ctx.user.id, email: ctx.user.email ?? null },
		});
	}

	@Mutation({ input: reworkInput, output: decisionResultOutput })
	async rework(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof reworkInput>,
	) {
		if (!ctx.user.id) throw new TRPCError({ code: "UNAUTHORIZED" });
		return this.decisions.rework({
			leadId: input.id,
			requestId: input.requestId,
			notes: input.notes,
			seen: input.seen,
			actor: { id: ctx.user.id, email: ctx.user.email ?? null },
		});
	}
}
