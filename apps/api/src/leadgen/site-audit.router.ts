import { Inject } from "@nestjs/common";
import { Input, Mutation, Query, Router, UseMiddlewares } from "nestjs-trpc";
import type { z } from "zod";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import { SessionOnlyMiddleware } from "../trpc/middlewares/session-only.middleware";
import {
	auditCachedInput,
	auditCachedOutput,
	auditInput,
	auditOutput,
} from "./site-audit.contracts";
import { SiteAuditService } from "./site-audit.service";

@Router({ alias: "leadgenAudit" })
@UseMiddlewares(AuthMiddleware, SessionOnlyMiddleware)
export class SiteAuditRouter {
	constructor(
		@Inject(SiteAuditService) private readonly audits: SiteAuditService,
	) {}

	@Query({ input: auditCachedInput, output: auditCachedOutput })
	async cached(@Input() input: z.infer<typeof auditCachedInput>) {
		return this.audits.cached(input.id);
	}

	@Mutation({ input: auditInput, output: auditOutput })
	async run(@Input() input: z.infer<typeof auditInput>) {
		return this.audits.run(input.id, { force: input.force });
	}
}
