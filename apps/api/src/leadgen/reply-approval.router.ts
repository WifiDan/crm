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
	replyDiscardInput,
	replyDiscardOutput,
	replyListInput,
	replyListOutput,
	replySendInput,
	replySendOutput,
	replyStatusOutput,
} from "./reply-approval.contracts";
import { ReplyApprovalService } from "./reply-approval.service";
import { ReplySendService } from "./reply-send.service";

/**
 * The approval surface for reply drafts and the ONLY door to ReplySendService.
 *
 * SessionOnlyMiddleware rejects any request carrying an API key, so an automation, an agent or a
 * script cannot send: it takes a signed-in human session. There is deliberately no REST/OpenAPI
 * meta on these procedures. reviewedBy is read from the session here and is not an input.
 */
@Router({ alias: "leadgenReplies" })
@UseMiddlewares(AuthMiddleware, SessionOnlyMiddleware)
export class ReplyApprovalRouter {
	constructor(
		@Inject(ReplyApprovalService)
		private readonly approvals: ReplyApprovalService,
		@Inject(ReplySendService) private readonly sender: ReplySendService,
	) {}

	@Query({ output: replyStatusOutput })
	async status(@Ctx() ctx: AuthedTrpcContext) {
		return this.approvals.status(ctx.user.email ?? null);
	}

	@Query({ input: replyListInput, output: replyListOutput })
	async list(@Input() input: z.infer<typeof replyListInput>) {
		return this.approvals.list(input.view);
	}

	@Mutation({ input: replySendInput, output: replySendOutput })
	async send(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof replySendInput>,
	) {
		if (!ctx.user.id) throw new TRPCError({ code: "UNAUTHORIZED" });
		return this.sender.sendReply({
			draftId: input.id,
			subject: input.subject,
			body: input.body,
			expectedTo: input.expectedTo,
			reviewer: { id: ctx.user.id, email: ctx.user.email ?? null },
		});
	}

	@Mutation({ input: replyDiscardInput, output: replyDiscardOutput })
	async discard(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof replyDiscardInput>,
	) {
		return this.approvals.discard(input.id, ctx.user.email ?? ctx.user.id);
	}
}
