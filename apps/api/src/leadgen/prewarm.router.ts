import { Inject } from "@nestjs/common";
import { Input, Mutation, Router, UseMiddlewares } from "nestjs-trpc";
import type { z } from "zod";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import { SessionOnlyMiddleware } from "../trpc/middlewares/session-only.middleware";
import { prewarmInput, prewarmOutput } from "./prewarm.contracts";
import { LeadgenPrewarmService } from "./prewarm.service";

@Router({ alias: "leadgenPrewarm" })
@UseMiddlewares(AuthMiddleware, SessionOnlyMiddleware)
export class PrewarmRouter {
	constructor(
		@Inject(LeadgenPrewarmService)
		private readonly prewarm: LeadgenPrewarmService,
	) {}

	@Mutation({ input: prewarmInput, output: prewarmOutput })
	async prepare(@Input() input: z.infer<typeof prewarmInput>) {
		return this.prewarm.prepare(input.id);
	}
}
