import { defineAgent, defineDynamic } from "eve";
import { z } from "zod";
import {
	DEFAULT_AGENT_MODEL_CONTEXT_WINDOW_TOKENS,
	defaultAgentModel,
} from "../../lib/default-model";
import { selectedModel } from "../../lib/model";

export default defineAgent({
	description:
		"Turn one private CRM builder-chat request into a validated, reviewable team-agent version without deploying it.",
	model: defineDynamic({
		fallback: defaultAgentModel,
		events: { "session.started": () => selectedModel() },
	}),
	modelContextWindowTokens: DEFAULT_AGENT_MODEL_CONTEXT_WINDOW_TOKENS,
	outputSchema: z.object({
		status: z.literal("draft_ready"),
		summary: z.string().min(1).max(1000),
		agentId: z.string().min(1),
		versionId: z.string().min(1),
	}),
	limits: {
		maxInputTokensPerSession: 100_000,
		maxOutputTokensPerSession: 10_000,
		sessionTimeoutMs: 24 * 60 * 60 * 1000,
	},
});
