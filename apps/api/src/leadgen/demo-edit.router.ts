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
	demoInfoInput,
	demoInfoOutput,
	previewInput,
	previewOutput,
	saveInput,
	saveOutput,
} from "./demo-edit.contracts";
import { DemoEditService } from "./demo-edit.service";

@Router({ alias: "leadgenDemos" })
@UseMiddlewares(AuthMiddleware, SessionOnlyMiddleware)
export class DemoEditRouter {
	constructor(
		@Inject(DemoEditService) private readonly demos: DemoEditService,
	) {}

	@Query({ input: demoInfoInput, output: demoInfoOutput })
	async info(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof demoInfoInput>,
	) {
		return this.demos.info(input.id, ctx.user.email ?? null);
	}

	@Mutation({ input: previewInput, output: previewOutput })
	async previewLink(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof previewInput>,
	) {
		if (!ctx.user.id) throw new TRPCError({ code: "UNAUTHORIZED" });
		return this.demos.previewLink(input.id, input.edit, {
			id: ctx.user.id,
			email: ctx.user.email ?? null,
		});
	}

	@Mutation({ input: saveInput, output: saveOutput })
	async save(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof saveInput>,
	) {
		if (!ctx.user.id) throw new TRPCError({ code: "UNAUTHORIZED" });
		return this.demos.save({
			leadId: input.id,
			requestId: input.requestId,
			html: input.html,
			baseSha256: input.baseSha256,
			actor: { id: ctx.user.id, email: ctx.user.email ?? null },
		});
	}
}
