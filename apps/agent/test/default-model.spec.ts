import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_MODEL } from "@crm/db/settings";
import { defaultAgentModel } from "../agent/lib/default-model";

/**
 * The point of these is that the default model is reached at Anthropic and not
 * at the Vercel AI Gateway, and that the key it presents is the one in the
 * environment. None of it needs a real key: the request never leaves the
 * process, because `fetch` is replaced for the duration.
 */

const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
	globalThis.fetch = realFetch;

	if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = realKey;
});

describe("the default model", () => {
	it("is an AI SDK language model, not a gateway id string", () => {
		// eve only routes around the gateway for a value that looks like this;
		// a string of any shape goes to the gateway instead.
		expect(typeof defaultAgentModel).not.toBe("string");
		expect(defaultAgentModel.specificationVersion).toMatch(/^v[234]$/);
		expect(typeof defaultAgentModel.doGenerate).toBe("function");
		expect(typeof defaultAgentModel.doStream).toBe("function");
	});

	it("is Anthropic's own model id, and agrees with the settings default", () => {
		// eve classifies routing off the provider name before the first dot.
		expect(defaultAgentModel.provider.split(".")[0]).toBe("anthropic");
		expect(defaultAgentModel.modelId).toBe(DEFAULT_AGENT_MODEL.providerModelId);
	});

	it("names the same model the settings page shows as the default", () => {
		// eve reports a direct model's identity in gateway form: the provider,
		// then the model id with the version's last hyphen turned into a dot.
		const asEveWouldReportIt = `${defaultAgentModel.provider.split(".")[0]}/${defaultAgentModel.modelId.replace(
			/^(claude-[a-z]+-\d+)-(\d+)$/,
			"$1.$2",
		)}`;

		expect(asEveWouldReportIt).toBe(DEFAULT_AGENT_MODEL.id);
	});
});

describe("the request the default model makes", () => {
	let seen: { url: string; headers: Record<string, string> } | null = null;

	beforeEach(() => {
		seen = null;

		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const headers: Record<string, string> = {};
			new Headers(init?.headers).forEach((value, key) => {
				headers[key] = value;
			});

			seen = { url: String(input), headers };

			return new Response(
				JSON.stringify({
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: DEFAULT_AGENT_MODEL.providerModelId,
					content: [{ type: "text", text: "ok" }],
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
	});

	it("goes to Anthropic, carrying the key from the environment", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";

		await defaultAgentModel.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		});

		expect(seen).not.toBeNull();
		expect(seen?.url).toStartWith("https://api.anthropic.com/");
		expect(seen?.url).not.toInclude("vercel");
		expect(seen?.headers["x-api-key"]).toBe("sk-ant-test-not-a-real-key");
		expect(seen?.headers["authorization"]).toBeUndefined();
	});

	it("says the key is missing rather than calling out without one", async () => {
		delete process.env.ANTHROPIC_API_KEY;

		const attempt = defaultAgentModel.doGenerate({
			prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		});

		await expect(attempt).rejects.toThrow(/ANTHROPIC_API_KEY|API key/i);
		expect(seen).toBeNull();
	});
});
