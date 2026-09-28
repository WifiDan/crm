import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { DEFAULT_AGENT_MODEL } from "@crm/db/settings";

/**
 * The compiled fallback model for every agent in this app.
 *
 * An AI SDK `LanguageModel` rather than a model-id string, which is the
 * difference that matters: eve classifies a string as gateway-routed and sends
 * it to the Vercel AI Gateway, and classifies a provider instance as
 * `external` and lets the provider's own SDK make the call. So this talks
 * straight to api.anthropic.com, authenticated with `ANTHROPIC_API_KEY`, and
 * no Vercel account is in the path.
 *
 * The key is read by `@ai-sdk/anthropic` when a request is made, not when this
 * module is loaded. An install with no key still builds and still boots; it
 * fails on the first model call, with Anthropic's own message.
 *
 * A model chosen on the settings page still overrides this per session, and
 * still goes through the gateway — see `selectedModel`.
 *
 * The type is annotated rather than inferred, and `@ai-sdk/provider` is a
 * direct dependency for the same reason: without a name it can reach, `tsc`
 * cannot write the type of anything holding this model — including each
 * agent's default export — and fails with TS2742. Deliberately not
 * `LanguageModel` from `ai`, which is a union that includes a plain model-id
 * string: the point here is the thing that is *not* a string, because a
 * string is what eve sends to the gateway.
 */
export const defaultAgentModel: LanguageModelV4 = anthropic(
	DEFAULT_AGENT_MODEL.providerModelId,
);

/**
 * Stated so that `eve build` does not have to ask the AI Gateway catalogue how
 * big this model's context window is. A direct provider model has no gateway
 * metadata to look up, and eve fails the build rather than guessing.
 */
export const DEFAULT_AGENT_MODEL_CONTEXT_WINDOW_TOKENS =
	DEFAULT_AGENT_MODEL.contextWindowTokens;
