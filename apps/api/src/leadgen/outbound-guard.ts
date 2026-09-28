import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { pipeline, type Transform, Writable } from "node:stream";
import zlib from "node:zlib";

export const OUTBOUND = {
	maxRedirects: 5,
	userAgent: "Mozilla/5.0",
} as const;

export class OutboundRefusedError extends Error {
	constructor(readonly reason: string) {
		super(`refused: ${reason}`);
		this.name = "OutboundRefusedError";
	}
}

export class OutboundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutboundError";
	}
}

type V4 = [number, number, number, number];
type V6 = [number, number, number, number, number, number, number, number];

function parseV4(text: string): V4 | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
	if (nums.some((n) => Number.isNaN(n) || n > 255)) return null;
	return nums as V4;
}

function parseV6(text: string): V6 | null {
	if (text.includes("%") || isIP(text) !== 6) return null;
	let work = text;
	const lastColon = work.lastIndexOf(":");
	const tail = work.slice(lastColon + 1);
	if (tail.includes(".")) {
		const v4 = parseV4(tail);
		if (!v4) return null;
		const hi = ((v4[0] << 8) | v4[1]).toString(16);
		const lo = ((v4[2] << 8) | v4[3]).toString(16);
		work = `${work.slice(0, lastColon + 1)}${hi}:${lo}`;
	}
	const halves = work.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? (halves[0] as string).split(":") : [];
	const rest =
		halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
	const groups = [
		...head,
		...(halves.length === 2 ? Array(missing).fill("0") : []),
		...rest,
	].map((g) => Number.parseInt(g, 16));
	if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
	return groups as V6;
}

function publicV4(o: V4): boolean {
	const [a, b, c] = o;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
	if (a === 192 && b === 88 && c === 99) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	if (a === 198 && b === 51 && c === 100) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	return true;
}

const v4Of = (hi: number, lo: number): V4 => [
	hi >> 8,
	hi & 255,
	lo >> 8,
	lo & 255,
];

function publicV6(g: V6): boolean {
	const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
	if (zeroTo(5) && g[5] === 0xffff) return publicV4(v4Of(g[6], g[7]));
	if (zeroTo(6)) return false;
	if (g[0] === 0x64 && g[1] === 0xff9b) {
		return g.slice(2, 6).every((x) => x === 0) && publicV4(v4Of(g[6], g[7]));
	}
	if (g[0] === 0x2002) return publicV4(v4Of(g[1], g[2]));
	if ((g[0] & 0xe000) !== 0x2000) return false;
	if (g[0] === 0x2001 && (g[1] < 0x0200 || g[1] === 0x0db8)) return false;
	if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return false;
	return true;
}

export function isPublicIp(text: string): boolean {
	const kind = isIP(text);
	if (kind === 4) {
		const v4 = parseV4(text);
		return v4 !== null && publicV4(v4);
	}
	if (kind === 6) {
		const v6 = parseV6(text);
		return v6 !== null && publicV6(v6);
	}
	return false;
}

const BLOCKED_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".localdomain",
	".lan",
	".home",
	".home.arpa",
	".corp",
	".ts.net",
] as const;

export function hostnameRefusal(rawHost: string): string | null {
	const host = rawHost
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host === "") return "empty host";
	if (isIP(host) !== 0) {
		return isPublicIp(host) ? null : `address ${host} is not a public address`;
	}
	if (host === "localhost") return "localhost";
	if (!host.includes(".")) return "single-label host name";
	const suffix = BLOCKED_SUFFIXES.find((s) => host.endsWith(s));
	if (suffix) return `${suffix} host names are internal`;
	return null;
}

export type Resolver = (
	host: string,
) => Promise<Array<{ address: string; family: number }>>;

export const systemResolver: Resolver = (host) =>
	dns.lookup(host, { all: true, verbatim: true });

export type ValidatedTarget = {
	url: URL;
	addresses: Array<{ address: string; family: number }>;
};

export async function assertPublicUrl(
	raw: string,
	resolve: Resolver,
): Promise<ValidatedTarget> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OutboundRefusedError("not a valid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new OutboundRefusedError(`scheme ${url.protocol} is not allowed`);
	if (url.username !== "" || url.password !== "")
		throw new OutboundRefusedError("URLs with credentials are not allowed");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const nameProblem = hostnameRefusal(host);
	if (nameProblem) throw new OutboundRefusedError(nameProblem);
	if (isIP(host) !== 0) {
		return { url, addresses: [{ address: host, family: isIP(host) }] };
	}
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await resolve(host);
	} catch (e) {
		throw new OutboundError(
			`could not resolve ${host}: ${e instanceof Error ? e.message : "lookup failed"}`,
		);
	}
	if (addresses.length === 0) throw new OutboundError(`no address for ${host}`);
	const bad = addresses.find((a) => !isPublicIp(a.address));
	if (bad)
		throw new OutboundRefusedError(
			`${host} resolves to ${bad.address}, which is not a public address`,
		);
	return { url, addresses };
}

export type HopRequest = {
	url: URL;
	addresses: Array<{ address: string; family: number }>;
	headers: Record<string, string>;
	timeoutMs: number;
	maxBytes: number;
};

export type HopResponse = {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
	truncated: boolean;
};

export type Transport = (hop: HopRequest) => Promise<HopResponse>;

function pinnedLookup(addresses: HopRequest["addresses"]) {
	const first =
		addresses.find((a) => a.family === 4) ??
		(addresses[0] as HopRequest["addresses"][number]);
	return (
		_host: string,
		options: { all?: boolean } | undefined,
		cb: (...args: unknown[]) => void,
	) => {
		if (options?.all)
			cb(null, [{ address: first.address, family: first.family }]);
		else cb(null, first.address, first.family);
	};
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function decoderFor(encoding: string): Transform | null {
	const e = encoding.toLowerCase().trim();
	if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
	if (e === "deflate") return zlib.createInflate();
	if (e === "br") return zlib.createBrotliDecompress();
	return null;
}

export const nodeTransport: Transport = (hop) =>
	new Promise((resolve, reject) => {
		const secure = hop.url.protocol === "https:";
		const host = hop.url.hostname.replace(/^\[|\]$/g, "");
		const lib = secure ? https : http;
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const req = lib.request(
			{
				host,
				port: hop.url.port || (secure ? 443 : 80),
				path: `${hop.url.pathname}${hop.url.search}`,
				method: "GET",
				headers: { ...hop.headers, Host: hop.url.host },
				lookup: pinnedLookup(hop.addresses) as never,
				servername: isIP(host) === 0 ? host : undefined,
				agent: false,
			},
			(res) => {
				const headers: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) {
					headers[k.toLowerCase()] = Array.isArray(v)
						? v.join(", ")
						: (v ?? "");
				}
				const status = res.statusCode ?? 0;
				if (REDIRECTS.has(status)) {
					res.resume();
					finish(() =>
						resolve({
							status,
							headers,
							body: new Uint8Array(),
							truncated: false,
						}),
					);
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				let truncated = false;
				const sink = new Writable({
					write(chunk: Buffer, _enc, done) {
						const room = hop.maxBytes - size;
						if (chunk.length >= room) {
							chunks.push(chunk.subarray(0, Math.max(0, room)));
							size = hop.maxBytes;
							truncated = true;
							req.destroy();
							done();
							return;
						}
						chunks.push(chunk);
						size += chunk.length;
						done();
					},
				});
				const decoder = decoderFor(headers["content-encoding"] ?? "");
				const finished = () =>
					finish(() =>
						resolve({
							status,
							headers,
							body: new Uint8Array(Buffer.concat(chunks)),
							truncated,
						}),
					);
				const done = (err?: Error | null) => {
					if (truncated || !err) finished();
					else finish(() => reject(new OutboundError(err.message)));
				};
				if (decoder) pipeline(res, decoder, sink, done);
				else pipeline(res, sink, done);
			},
		);
		const timer = setTimeout(() => {
			req.destroy();
			finish(() => reject(new OutboundError("timed out")));
		}, hop.timeoutMs);
		req.on("error", (e) => finish(() => reject(new OutboundError(e.message))));
		req.end();
	});

export type FetchOptions = {
	maxBytes: number;
	timeoutMs: number;
	maxRedirects?: number;
	userAgent?: string;
};

export type FetchDeps = { resolve?: Resolver; transport?: Transport };

export type PublicFetchResult = {
	status: number;
	finalUrl: string;
	text: string;
	truncated: boolean;
	hops: number;
};

export async function fetchPublic(
	rawUrl: string,
	options: FetchOptions,
	deps: FetchDeps = {},
): Promise<PublicFetchResult> {
	const resolve = deps.resolve ?? systemResolver;
	const transport = deps.transport ?? nodeTransport;
	const maxRedirects = options.maxRedirects ?? OUTBOUND.maxRedirects;
	const deadline = Date.now() + options.timeoutMs;
	let current = rawUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const target = await assertPublicUrl(current, resolve);
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new OutboundError("timed out");
		const response = await transport({
			url: target.url,
			addresses: target.addresses,
			timeoutMs: remaining,
			maxBytes: options.maxBytes,
			headers: {
				"User-Agent": options.userAgent ?? OUTBOUND.userAgent,
				Accept: "*/*",
				"Accept-Encoding": "gzip, deflate, br",
				Connection: "close",
			},
		});
		const location = response.headers.location;
		if (REDIRECTS.has(response.status) && location) {
			try {
				current = new URL(location, target.url).href;
			} catch {
				throw new OutboundError("redirect to an invalid address");
			}
			continue;
		}
		return {
			status: response.status,
			finalUrl: target.url.href,
			text: new TextDecoder("utf-8").decode(response.body),
			truncated: response.truncated,
			hops: hop,
		};
	}
	throw new OutboundError("too many redirects");
}
