import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { type Db } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import type { LgJobContext, LgJobHandler, LgJobResult } from "./job-handler";
import {
	buildDraftPrompt,
	type DraftOutput,
	needsDraft,
	parseDraftOutput,
} from "./reply-draft";
import { extractTopText, hasNewText } from "./reply-rules";

const run = promisify(execFile);
const BATCH = Number(process.env.LEADGEN_DRAFTS_PER_RUN ?? "4");
const WINDOW_DAYS = 14;
const MAX_ATTEMPTS = 3;
const FAILED_TAG = /^llm-failed x(\d+)/;

type Candidate = Awaited<ReturnType<RepliesDraftHandler["candidates"]>>[number];

/**
 * Phase 3b. For each real human reply the deterministic rules could not settle, asks Claude
 * (headless, the same OAuth credential the site builder uses) to classify it and, if it is worth
 * answering, draft a reply. The draft lands in lg_reply_draft as PENDING for Danio to approve.
 *
 * It NEVER sends. There is no mail-sending code in this module or anywhere in the leadgen
 * directory (enforced by leadgen-no-send.spec.ts): the only way a draft becomes an email is a
 * later, authenticated UI action by Danio.
 *
 * Volume is deliberately tiny (a few replies a day, BATCH per run): it shares Danio's plan limit.
 */
@Injectable()
export class RepliesDraftHandler implements LgJobHandler {
	readonly name = "replies.draft";
	private readonly logger = new Logger(RepliesDraftHandler.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async run(ctx: LgJobContext): Promise<LgJobResult> {
		const rows = await this.candidates();
		const c = {
			candidates: rows.length,
			drafted: 0,
			classifiedOnly: 0,
			failed: 0,
		};
		for (const row of rows) {
			if (ctx.signal.aborted) throw new Error("aborted");
			let failure = "no lead matched";
			const out = await this.ask(row).catch((e: unknown) => {
				failure = String(e).slice(0, 160);
				this.logger.warn(`draft failed for ${row.id}: ${failure}`);
				return null;
			});
			if (!out) {
				c.failed++;
				await this.noteFailure(row, failure);
				continue;
			}
			await this.save(row, out);
			if (needsDraft(out.classification)) c.drafted++;
			else c.classifiedOnly++;
		}
		if (c.failed > 0 && c.failed === c.candidates) {
			throw new Error(`every one of ${c.candidates} drafting attempts failed`);
		}
		return { counters: c };
	}

	async candidates() {
		return this.db.lgInboundMessage.findMany({
			where: {
				classification: null,
				matchedLeadId: { not: null },
				answeredAt: null,
				receivedAt: { gte: new Date(Date.now() - WINDOW_DAYS * 86_400_000) },
				replyDrafts: { none: {} },
				OR: [
					{ classificationEvidence: null },
					{
						classificationEvidence: {
							not: { startsWith: `llm-failed x${MAX_ATTEMPTS}` },
						},
					},
				],
			},
			orderBy: { receivedAt: "desc" },
			take: BATCH,
			include: {
				matchedLead: {
					select: {
						id: true,
						businessName: true,
						demoUrl: true,
						campaign: { select: { offerPrice: true, offerMonthly: true } },
						sends: {
							orderBy: { sentAt: "asc" },
							take: 1,
							select: { subject: true },
						},
					},
				},
			},
		});
	}

	private async ask(row: Candidate): Promise<DraftOutput | null> {
		const lead = row.matchedLead;
		if (!lead) return null;
		const newText = extractTopText(row.bodyText ?? "").top;
		if (!hasNewText(newText))
			throw new Error("no new text isolated - needs a human");
		const prompt = buildDraftPrompt({
			businessName: lead.businessName,
			demoUrl: lead.demoUrl,
			originalSubject: lead.sends[0]?.subject ?? null,
			replyText: newText,
			offerPrice: lead.campaign?.offerPrice?.toString() ?? null,
			offerMonthly: lead.campaign?.offerMonthly?.toString() ?? null,
		});
		const { stdout } = await run(
			process.env.LEADGEN_CLAUDE_BIN ?? "/home/danio/.npm-global/bin/claude",
			[
				"-p",
				prompt,
				"--model",
				process.env.LEADGEN_DRAFT_MODEL ?? "sonnet",
				"--output-format",
				"json",
				"--max-budget-usd",
				"1.5",
				"--strict-mcp-config",
				"--disallowedTools",
				"Bash,Write,Edit,WebFetch,WebSearch",
			],
			{
				cwd: tmpdir(),
				timeout: 240_000,
				maxBuffer: 4_000_000,
				env: {
					...process.env,
					TMPDIR: process.env.TMPDIR ?? "/home/danio/tmp",
				},
			},
		);
		const wrapper = JSON.parse(stdout) as {
			result?: string;
			is_error?: boolean;
		};
		if (wrapper.is_error) throw new Error(String(wrapper.result).slice(0, 160));
		const parsed = parseDraftOutput(String(wrapper.result ?? ""));
		if (!parsed.ok) throw new Error(parsed.error);
		return parsed.value;
	}

	/** A reply that keeps failing must stop costing plan usage; after MAX_ATTEMPTS it waits for a human. */
	private async noteFailure(row: Candidate, why: string): Promise<void> {
		const prior = FAILED_TAG.exec(row.classificationEvidence ?? "")?.[1];
		const n = Math.min(MAX_ATTEMPTS, Number(prior ?? 0) + 1);
		await this.db.lgInboundMessage.update({
			where: { id: row.id },
			data: {
				classificationEvidence: `llm-failed x${n}: ${why.slice(0, 100)}`,
			},
		});
	}

	private async save(row: Candidate, out: DraftOutput): Promise<void> {
		const leadId = row.matchedLead?.id;
		if (!leadId) return;
		await this.db.lgInboundMessage.update({
			where: { id: row.id },
			data: {
				classification: out.classification,
				classificationEvidence: `llm: ${out.rationale}`,
			},
		});
		if (!needsDraft(out.classification)) return;
		const checks = out.checks.length
			? `\nCHECK: ${out.checks.join(" | ")}`
			: "";
		await this.db.lgReplyDraft.create({
			data: {
				inboundMessageId: row.id,
				leadId,
				draftSubject: out.draft_subject,
				draftBody: out.draft_body,
				rationale: `${out.rationale}${checks}`,
				status: "PENDING",
			},
		});
	}
}
