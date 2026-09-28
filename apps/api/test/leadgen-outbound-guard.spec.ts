import { describe, expect, test } from "bun:test";
import http from "node:http";
import {
	assertPublicUrl,
	fetchPublic,
	type HopRequest,
	hostnameRefusal,
	isPublicIp,
	nodeTransport,
	OutboundError,
	OutboundRefusedError,
	type Resolver,
	type Transport,
} from "../src/leadgen/outbound-guard";

const PUBLIC = "93.184.216.34";

const dns =
	(table: Record<string, string[]>): Resolver =>
	async (host) => {
		const found = table[host];
		if (!found) throw new Error("ENOTFOUND");
		return found.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));
	};

const resolver = dns({
	"site.example.com": [PUBLIC],
	"rebind.example.com": ["10.0.0.5"],
	"mixed.example.com": [PUBLIC, "127.0.0.1"],
	"v6private.example.com": ["fd7a:115c:a1e0::1"],
	"redirector.example.com": [PUBLIC],
});

const refused = async (fn: () => Promise<unknown>) => {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	return null;
};

const spyTransport = (
	answers: Array<{ status: number; location?: string; body?: string }>,
) => {
	const calls: HopRequest[] = [];
	const transport: Transport = async (hop) => {
		calls.push(hop);
		const a = answers[calls.length - 1] ?? { status: 200, body: "" };
		return {
			status: a.status,
			headers: (a.location ? { location: a.location } : {}) as Record<
				string,
				string
			>,
			body: new TextEncoder().encode(a.body ?? ""),
			truncated: false,
		};
	};
	return { calls, transport };
};

describe("address classification", () => {
	const blocked = [
		"127.0.0.1",
		"127.255.255.254",
		"0.0.0.0",
		"10.0.0.1",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"100.78.149.77",
		"100.127.255.255",
		"192.0.2.1",
		"198.18.0.1",
		"224.0.0.1",
		"255.255.255.255",
		"::1",
		"::",
		"fe80::1",
		"fc00::1",
		"fd7a:115c:a1e0::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:10.0.0.1",
		"::ffff:169.254.169.254",
		"64:ff9b::7f00:1",
		"2002:7f00:1::1",
		"2001:db8::1",
		"ff02::1",
		"::127.0.0.1",
	];
	for (const ip of blocked) {
		test(`refuses ${ip}`, () => expect(isPublicIp(ip)).toBe(false));
	}
	const allowed = [
		PUBLIC,
		"8.8.8.8",
		"1.1.1.1",
		"172.15.255.255",
		"172.32.0.1",
		"100.63.255.255",
		"100.128.0.1",
		"2606:4700:4700::1111",
		"2a00:1450:4001:81b::200e",
		"::ffff:8.8.8.8",
	];
	for (const ip of allowed) {
		test(`allows ${ip}`, () => expect(isPublicIp(ip)).toBe(true));
	}
	test("garbage is not public", () => {
		expect(isPublicIp("not an ip")).toBe(false);
		expect(isPublicIp("")).toBe(false);
		expect(isPublicIp("999.1.1.1")).toBe(false);
	});
});

describe("host names", () => {
	for (const host of [
		"localhost",
		"foo.localhost",
		"printer.local",
		"db.internal",
		"joshua",
		"joshua.tail261548.ts.net",
		"nas.lan",
		"router.home.arpa",
		"",
	]) {
		test(`refuses ${JSON.stringify(host)}`, () =>
			expect(hostnameRefusal(host)).not.toBeNull());
	}
	test("allows an ordinary name", () =>
		expect(hostnameRefusal("elitesystemsdesign.com")).toBeNull());
});

describe("the URLs the spec names are refused before any request", () => {
	const targets = [
		"http://127.0.0.1:3041/",
		"http://100.78.149.77:8768/",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost/",
		"http://[::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://2130706433/",
		"http://0x7f.1/",
		"http://0177.0.0.1/",
		"http://127.1/",
		"http://joshua.tail261548.ts.net:8768/",
		"http://rebind.example.com/",
		"http://mixed.example.com/",
		"http://v6private.example.com/",
		"http://user:pass@site.example.com/",
		"file:///etc/passwd",
		"ftp://site.example.com/",
		"gopher://site.example.com/",
		"javascript:alert(1)",
		"not a url",
	];
	for (const target of targets) {
		test(`refuses ${target} and never calls the transport`, async () => {
			const { calls, transport } = spyTransport([{ status: 200 }]);
			const err = await refused(() =>
				fetchPublic(
					target,
					{ maxBytes: 1000, timeoutMs: 1000 },
					{ resolve: resolver, transport },
				),
			);
			expect(err).toBeInstanceOf(OutboundRefusedError);
			expect(calls.length).toBe(0);
		});
	}

	test("the refusal names the reason for a private resolution", async () => {
		const err = (await refused(() =>
			assertPublicUrl("http://rebind.example.com/", resolver),
		)) as OutboundRefusedError;
		expect(err.reason).toContain("10.0.0.5");
	});

	test("a public URL is allowed and carries the validated address", async () => {
		const { calls, transport } = spyTransport([{ status: 200, body: "hi" }]);
		const out = await fetchPublic(
			"https://site.example.com/a?b=1",
			{ maxBytes: 1000, timeoutMs: 1000 },
			{ resolve: resolver, transport },
		);
		expect(out.text).toBe("hi");
		expect(calls[0]?.addresses).toEqual([{ address: PUBLIC, family: 4 }]);
		expect(calls[0]?.url.href).toBe("https://site.example.com/a?b=1");
	});

	test("an unresolvable name is an error, not a refusal", async () => {
		const err = await refused(() =>
			fetchPublic(
				"http://nowhere.example.com/",
				{ maxBytes: 10, timeoutMs: 1000 },
				{ resolve: resolver, transport: spyTransport([]).transport },
			),
		);
		expect(err).toBeInstanceOf(OutboundError);
		expect(err).not.toBeInstanceOf(OutboundRefusedError);
	});
});

describe("redirects are re-checked on every hop", () => {
	const redirectTargets = [
		"http://127.0.0.1/",
		"http://127.0.0.1:3041/api",
		"http://100.78.149.77:8768/",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost/",
		"http://rebind.example.com/",
		"/../../etc",
	];
	for (const location of redirectTargets.slice(0, 6)) {
		test(`a public URL that redirects to ${location} is refused after one request`, async () => {
			const { calls, transport } = spyTransport([{ status: 302, location }]);
			const err = await refused(() =>
				fetchPublic(
					"http://redirector.example.com/start",
					{ maxBytes: 1000, timeoutMs: 1000 },
					{ resolve: resolver, transport },
				),
			);
			expect(err).toBeInstanceOf(OutboundRefusedError);
			expect(calls.length).toBe(1);
		});
	}

	test("a redirect between two public hosts is followed and its final URL reported", async () => {
		const { calls, transport } = spyTransport([
			{ status: 301, location: "https://site.example.com/next" },
			{ status: 200, body: "done" },
		]);
		const out = await fetchPublic(
			"http://redirector.example.com/",
			{ maxBytes: 1000, timeoutMs: 1000 },
			{ resolve: resolver, transport },
		);
		expect(calls.length).toBe(2);
		expect(out.finalUrl).toBe("https://site.example.com/next");
		expect(out.hops).toBe(1);
	});

	test("a relative redirect resolves against the current host", async () => {
		const { calls, transport } = spyTransport([
			{ status: 302, location: "/moved" },
			{ status: 200, body: "ok" },
		]);
		await fetchPublic(
			"http://redirector.example.com/a",
			{ maxBytes: 1000, timeoutMs: 1000 },
			{ resolve: resolver, transport },
		);
		expect(calls[1]?.url.href).toBe("http://redirector.example.com/moved");
	});

	test("the redirect chain is capped", async () => {
		const loop = Array.from({ length: 20 }, () => ({
			status: 302,
			location: "http://redirector.example.com/again",
		}));
		const { calls, transport } = spyTransport(loop);
		const err = await refused(() =>
			fetchPublic(
				"http://redirector.example.com/",
				{ maxBytes: 1000, timeoutMs: 1000, maxRedirects: 3 },
				{ resolve: resolver, transport },
			),
		);
		expect(err).toBeInstanceOf(OutboundError);
		expect((err as Error).message).toContain("redirects");
		expect(calls.length).toBe(4);
	});
});

describe("the real transport", () => {
	const serve = (
		handler: http.RequestListener,
	): Promise<{ port: number; close: () => void }> =>
		new Promise((resolve) => {
			const server = http.createServer(handler);
			server.listen(0, "127.0.0.1", () =>
				resolve({
					port: (server.address() as { port: number }).port,
					close: () => server.close(),
				}),
			);
		});

	const hop = (port: number, over: Partial<HopRequest> = {}): HopRequest => ({
		url: new URL(`http://pinned.example.com:${port}/x`),
		addresses: [{ address: "127.0.0.1", family: 4 }],
		headers: { "User-Agent": "t" },
		timeoutMs: 2000,
		maxBytes: 1000,
		...over,
	});

	test("connects to the validated address, whatever the name would resolve to", async () => {
		const s = await serve((req, res) => res.end(`host=${req.headers.host}`));
		try {
			const out = await nodeTransport(hop(s.port));
			expect(new TextDecoder().decode(out.body)).toBe(
				`host=pinned.example.com:${s.port}`,
			);
		} finally {
			s.close();
		}
	});

	test("stops reading at the byte cap and says so", async () => {
		const s = await serve((_req, res) => res.end("a".repeat(5000)));
		try {
			const out = await nodeTransport(hop(s.port, { maxBytes: 100 }));
			expect(out.body.length).toBe(100);
			expect(out.truncated).toBe(true);
		} finally {
			s.close();
		}
	});

	test("gives up at the time cap", async () => {
		const s = await serve(() => {});
		try {
			const err = await refused(() =>
				nodeTransport(hop(s.port, { timeoutMs: 150 })),
			);
			expect(err).toBeInstanceOf(OutboundError);
			expect((err as Error).message).toBe("timed out");
		} finally {
			s.close();
		}
	});

	test("does not follow redirects itself", async () => {
		const s = await serve((_req, res) => {
			res.writeHead(302, { Location: "http://127.0.0.1:1/" });
			res.end();
		});
		try {
			const out = await nodeTransport(hop(s.port));
			expect(out.status).toBe(302);
			expect(out.headers.location).toBe("http://127.0.0.1:1/");
		} finally {
			s.close();
		}
	});

	test("caps a compressed body by its decompressed size", async () => {
		const zlib = await import("node:zlib");
		const bomb = zlib.gzipSync(Buffer.alloc(5_000_000, 97));
		const s = await serve((_req, res) => {
			res.writeHead(200, { "Content-Encoding": "gzip" });
			res.end(bomb);
		});
		try {
			const out = await nodeTransport(hop(s.port, { maxBytes: 1000 }));
			expect(out.body.length).toBe(1000);
			expect(out.truncated).toBe(true);
		} finally {
			s.close();
		}
	});
});
