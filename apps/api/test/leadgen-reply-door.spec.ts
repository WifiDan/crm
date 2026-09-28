import { describe, expect, test } from "bun:test";
import { API_KEY_HEADER } from "@crm/auth";
import type { MiddlewareOptions } from "nestjs-trpc";
import { AuthMiddleware } from "../src/trpc/middlewares/auth.middleware";
import { SessionOnlyMiddleware } from "../src/trpc/middlewares/session-only.middleware";

/**
 * The reply-approval router stacks AuthMiddleware then SessionOnlyMiddleware
 * (asserted in leadgen-no-send.spec.ts). These tests prove each one actually closes its door.
 */
const opts = (ctx: unknown) =>
	({
		ctx,
		next: async (o?: unknown) => ({ ok: true, o }),
	}) as unknown as MiddlewareOptions;

describe("the human-session door", () => {
	test("no session at all is UNAUTHORIZED", async () => {
		await expect(
			new AuthMiddleware().use(opts({ session: null })),
		).rejects.toThrow(/UNAUTHORIZED/);
	});

	test("a signed-in session passes AuthMiddleware", async () => {
		const res = await new AuthMiddleware().use(
			opts({ session: { user: { id: "u1", email: "danio@wifielite.com" } } }),
		);
		expect((res as unknown as { ok: boolean }).ok).toBe(true);
	});

	test("a request carrying an API key is rejected even with a valid-looking session", async () => {
		await expect(
			new SessionOnlyMiddleware().use(
				opts({
					session: { user: { id: "u1" } },
					req: { headers: { [API_KEY_HEADER]: "some-key" } },
				}),
			),
		).rejects.toThrow(/UNAUTHORIZED/);
	});

	test("a browser session with no API key header passes SessionOnlyMiddleware", async () => {
		const res = await new SessionOnlyMiddleware().use(
			opts({ session: { user: { id: "u1" } }, req: { headers: {} } }),
		);
		expect((res as unknown as { ok: boolean }).ok).toBe(true);
	});
});
