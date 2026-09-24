import { Inject } from "@nestjs/common";
import { Input, Mutation, Query, Router, UseMiddlewares } from "nestjs-trpc";
import type { z } from "zod";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import { SessionOnlyMiddleware } from "../trpc/middlewares/session-only.middleware";
import {
	shotCaptureInput,
	shotCaptureOutput,
	shotStatusInput,
	shotStatusOutput,
} from "./shot.contracts";
import { LeadgenShotService } from "./shot.service";

@Router({ alias: "leadgenShots" })
@UseMiddlewares(AuthMiddleware, SessionOnlyMiddleware)
export class ShotRouter {
	constructor(
		@Inject(LeadgenShotService) private readonly shots: LeadgenShotService,
	) {}

	@Query({ input: shotStatusInput, output: shotStatusOutput })
	async status(@Input() input: z.infer<typeof shotStatusInput>) {
		return this.shots.status(input.id);
	}

	@Mutation({ input: shotCaptureInput, output: shotCaptureOutput })
	async capture(@Input() input: z.infer<typeof shotCaptureInput>) {
		return this.shots.capture(input.id, input.force);
	}
}
