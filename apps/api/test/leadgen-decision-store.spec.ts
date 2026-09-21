import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	NocoWriteError,
	nocodbLeadStore,
} from "../src/leadgen/lead-decision.store";

const TOKEN = "stub-token-not-a-real-secret";
const OTHER = "stub-dedicated-token";

type Seen = {
	method: string;
	path: string;
	token: string | null;
	contentType: string | null;
	body: string;
};

let server: ReturnType<typeof Bun.serve>;
let base = "";
let seen: Seen[] = [];
let respond: (req: Request, path: string) => Response | Promise<Response> =
	() => new Response("{}");

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const path = new URL(req.url).pathname;
			seen.push({
				method: req.method,
				path,
				token: req.headers.get("xc-token"),
				contentType: req.headers.get("content-type"),
				body: await req.text(),
			});
			return respond(req, path);
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

const reset = (fn: typeof respond) => {
	seen = [];
	respond = fn;
};

const store = (
	env: Record<string, string | undefined> = {},
	timeoutMs?: number,
) =>
	nocodbLeadStore(
		{ NOCODB_URL: base, NOCODB_LEADS_TOKEN: TOKEN, ...env },
		fetch,
		timeoutMs,
	);

describe("write configuration", () => {
	test("needs a URL and a token", () => {
		expect(nocodbLeadStore({}).writeConfig()).toEqual({
			ok: false,
			reason: "NOCODB_URL is not set",
		});
		expect(nocodbLeadStore({ NOCODB_URL: base }).writeConfig().ok).toBe(false);
		expect(
			nocodbLeadStore({
				NOCODB_URL: "not a url",
				NOCODB_LEADS_TOKEN: "x",
			}).writeConfig().ok,
		).toBe(false);
	});
	test("prefers the dedicated write token and says which one is in use", () => {
		expect(store().writeConfig()).toEqual({
			ok: true,
			source: "shared-with-mirror",
		});
		expect(store({ NOCODB_LEADS_WRITE_TOKEN: OTHER }).writeConfig()).toEqual({
			ok: true,
			source: "dedicated",
		});
	});
	test("the config result never carries a token", () => {
		const out = JSON.stringify(
			store({ NOCODB_LEADS_WRITE_TOKEN: OTHER }).writeConfig(),
		);
		expect(out).not.toContain(OTHER);
		expect(out).not.toContain(TOKEN);
	});
	test("the dedicated token is the one sent", async () => {
		reset(() => Response.json({ Id: 1 }));
		await store({ NOCODB_LEADS_WRITE_TOKEN: OTHER }).getRow("t1", 1);
		expect(seen[0]?.token).toBe(OTHER);
	});
});

describe("reads", () => {
	test("GET one record by id with the token header", async () => {
		reset(() => Response.json({ Id: 5, "Approval Decision": "Approved" }));
		const row = await store().getRow("tbl", 5);
		expect(row).toEqual({ Id: 5, "Approval Decision": "Approved" });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			method: "GET",
			path: "/api/v2/tables/tbl/records/5",
			token: TOKEN,
		});
	});
	test("404 is null, other failures throw", async () => {
		reset(() => new Response("{}", { status: 404 }));
		expect(await store().getRow("tbl", 5)).toBeNull();
		reset(() => new Response("{}", { status: 500 }));
		await expect(store().getRow("tbl", 5)).rejects.toThrow(/500/);
	});
	test("an array or junk body is refused", async () => {
		reset(() => Response.json([1, 2]));
		await expect(store().getRow("tbl", 5)).rejects.toThrow();
	});
	test("column state: present, absent, unknown", async () => {
		reset(() =>
			Response.json({ columns: [{ title: "Id" }, { title: "Send Approved" }] }),
		);
		expect(await store().columnState("tbl", "Send Approved")).toBe("present");
		expect(seen[0]?.path).toBe("/api/v2/meta/tables/tbl");
		reset(() => Response.json({ columns: [{ title: "Id" }] }));
		expect(await store().columnState("tbl", "Send Approved")).toBe("absent");
		reset(() => new Response("{}", { status: 500 }));
		expect(await store().columnState("tbl", "Send Approved")).toBe("unknown");
		reset(() => Response.json({ nothing: true }));
		expect(await store().columnState("tbl", "Send Approved")).toBe("unknown");
	});
	test("no reads use a write verb", async () => {
		reset(() => Response.json({ Id: 1, columns: [] }));
		await store().getRow("t", 1);
		await store().columnState("t", "x");
		expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
	});
});

describe("patch", () => {
	test("sends one PATCH with the exact body", async () => {
		reset(() => Response.json({ Id: 5 }));
		const patch = {
			Id: 5,
			"Approval Decision": "Approved",
			"Send Approved": true,
		};
		await store().patchRow("tbl", patch);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			method: "PATCH",
			path: "/api/v2/tables/tbl/records",
			token: TOKEN,
			contentType: "application/json",
		});
		expect(JSON.parse(seen[0]?.body ?? "")).toEqual(patch);
	});
	const cases: Array<[number, "rejected" | "unknown"]> = [
		[400, "rejected"],
		[401, "rejected"],
		[403, "rejected"],
		[404, "rejected"],
		[422, "rejected"],
		[429, "rejected"],
		[408, "unknown"],
		[500, "unknown"],
		[502, "unknown"],
		[503, "unknown"],
		[504, "unknown"],
	];
	for (const [status, kind] of cases) {
		test(`status ${status} is ${kind}`, async () => {
			reset(() => new Response(`upstream said ${TOKEN}`, { status }));
			const err = await store()
				.patchRow("tbl", { Id: 1 })
				.catch((e) => e);
			expect(err).toBeInstanceOf(NocoWriteError);
			expect(err.kind).toBe(kind);
			expect(err.status).toBe(status);
			expect(seen).toHaveLength(1);
		});
	}
	test("error messages never carry the token or the response body", async () => {
		reset(() => new Response(`leaked ${TOKEN}`, { status: 500 }));
		const err = await store()
			.patchRow("tbl", { Id: 1 })
			.catch((e) => e);
		expect(String(err.message)).not.toContain(TOKEN);
		expect(String(err.message)).not.toContain("leaked");
	});
	test("a hung server is a timeout, recorded as unknown, and not retried", async () => {
		reset(async () => {
			await Bun.sleep(400);
			return Response.json({ Id: 1 });
		});
		const err = await store({}, 100)
			.patchRow("tbl", { Id: 1 })
			.catch((e) => e);
		expect(err).toBeInstanceOf(NocoWriteError);
		expect(err.kind).toBe("unknown");
		await Bun.sleep(500);
		expect(seen).toHaveLength(1);
	});
	test("nothing listening: a definite refusal, since nothing could have been written", async () => {
		const dead = nocodbLeadStore({
			NOCODB_URL: "http://127.0.0.1:1",
			NOCODB_LEADS_TOKEN: TOKEN,
		});
		const err = await dead.patchRow("tbl", { Id: 1 }).catch((e) => e);
		expect(err).toBeInstanceOf(NocoWriteError);
		expect(err.kind).toBe("rejected");
	});
});

describe("the stub is local", () => {
	test("the test server is bound to loopback", () => {
		expect(base.startsWith("http://127.0.0.1:")).toBe(true);
	});
});
