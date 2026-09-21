import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hostnameRefusal, isPublicIp } from "./outbound-guard";

export const SHOT_LIMITS = {
	viewport: { width: 1280, height: 900 },
	totalMs: 20_000,
	loadWaitMs: 15_000,
	settleMs: 1_500,
	launchMs: 10_000,
	minBytes: 1_000,
} as const;

export class ShotError extends Error {
	constructor(
		readonly kind: "refused" | "failed" | "unavailable",
		message: string,
	) {
		super(message);
		this.name = "ShotError";
	}
}

export type BrowserInstall = { binary: string; libDirs: string[] };

const dirsIn = (dir: string): string[] => {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
};

export function findBrowser(
	home: string = homedir(),
	override?: string,
): BrowserInstall | null {
	const root = override ?? join(home, ".cache", "leadgen-browser");
	const shellRoot = join(root, "chrome-headless-shell");
	for (const version of dirsIn(shellRoot).sort().reverse()) {
		for (const inner of dirsIn(join(shellRoot, version))) {
			const binary = join(shellRoot, version, inner, "chrome-headless-shell");
			if (existsSync(binary)) {
				const base = join(root, "libs", "usr", "lib", "x86_64-linux-gnu");
				const libDirs = [base, join(base, "gbm")].filter((d) => existsSync(d));
				return { binary, libDirs };
			}
		}
	}
	return null;
}

export type NavRecord = {
	url: string;
	status: number | null;
	remoteIp: string | null;
	frame?: string | null;
};

const bare = (ip: string) => ip.replace(/^\[|\]$/g, "");

export function verifyChain(chain: NavRecord[]): NavRecord {
	const last = chain.at(-1);
	if (!last) throw new ShotError("failed", "the page never answered");
	for (const hop of chain) {
		let host = "";
		try {
			host = new URL(hop.url).hostname;
		} catch {
			throw new ShotError("refused", "the page left for an invalid address");
		}
		const nameProblem = hostnameRefusal(host);
		if (nameProblem)
			throw new ShotError(
				"refused",
				`the page went to ${host}: ${nameProblem}`,
			);
		if (!hop.remoteIp)
			throw new ShotError(
				"refused",
				`could not confirm which address ${host} answered from`,
			);
		if (!isPublicIp(bare(hop.remoteIp)))
			throw new ShotError(
				"refused",
				`${host} answered from ${bare(hop.remoteIp)}, which is not a public address`,
			);
	}
	return last;
}

export function allowRequest(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (
		url.protocol === "data:" ||
		url.protocol === "blob:" ||
		url.protocol === "about:"
	)
		return true;
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	return hostnameRefusal(url.hostname) === null;
}

export type CdpMessage = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: string };
	sessionId?: string;
};

export type CdpConnection = {
	send: (
		method: string,
		params?: Record<string, unknown>,
		sessionId?: string,
	) => Promise<Record<string, unknown>>;
	onEvent: (fn: (m: CdpMessage) => void) => void;
	close: () => void;
};

export type Launched = {
	wsUrl: string;
	stop: () => Promise<void>;
};

export type Launcher = (install: BrowserInstall) => Promise<Launched>;

export type Connector = (wsUrl: string) => Promise<CdpConnection>;

export type ShotResult = {
	png: Buffer;
	finalUrl: string;
	httpStatus: number | null;
	blockedRequests: number;
};

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

const CHROME_ARGS = [
	"--headless",
	"--disable-gpu",
	"--hide-scrollbars",
	"--no-sandbox",
	"--disable-dev-shm-usage",
	"--disable-extensions",
	"--disable-background-networking",
	"--disable-sync",
	"--disable-default-apps",
	"--disable-component-update",
	"--no-first-run",
	"--mute-audio",
	"--remote-debugging-port=0",
	`--window-size=${SHOT_LIMITS.viewport.width},${SHOT_LIMITS.viewport.height}`,
	"about:blank",
];

export const spawnBrowser: Launcher = async (install) => {
	const profile = await mkdtemp(join(tmpdir(), "leadgen-shot-"));
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin",
		HOME: profile,
		LANG: "C.UTF-8",
		LD_LIBRARY_PATH: install.libDirs.join(":"),
	};
	const child: ChildProcess = spawn(
		install.binary,
		[...CHROME_ARGS, `--user-data-dir=${profile}`],
		{ env: env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] },
	);
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
	const stop = async () => {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await Promise.race([exited, sleep(3000)]);
		await rm(profile, { recursive: true, force: true }).catch(() => {});
	};
	try {
		const wsUrl = await new Promise<string>((resolve, reject) => {
			let seen = "";
			const timer = setTimeout(
				() => reject(new ShotError("failed", "the browser did not start")),
				SHOT_LIMITS.launchMs,
			);
			child.stderr?.on("data", (chunk: Buffer) => {
				seen = (seen + chunk.toString()).slice(-4000);
				const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
				if (m) {
					clearTimeout(timer);
					resolve(m[1] as string);
				}
			});
			child.once("exit", () => {
				clearTimeout(timer);
				reject(new ShotError("failed", "the browser exited on start"));
			});
			child.once("error", (e) => {
				clearTimeout(timer);
				reject(
					new ShotError("failed", `could not start the browser: ${e.message}`),
				);
			});
		});
		return { wsUrl, stop };
	} catch (e) {
		await stop();
		throw e;
	}
};

export const connectWebSocket: Connector = (wsUrl) =>
	new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let nextId = 1;
		const pending = new Map<
			number,
			{ ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void }
		>();
		const listeners: Array<(m: CdpMessage) => void> = [];
		ws.onmessage = (event) => {
			const msg = JSON.parse(String(event.data)) as CdpMessage;
			if (msg.id !== undefined) {
				const waiter = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.error)
					waiter?.fail(new Error(msg.error.message ?? "cdp error"));
				else waiter?.ok(msg.result ?? {});
				return;
			}
			for (const fn of listeners) fn(msg);
		};
		ws.onerror = () => reject(new ShotError("failed", "browser link failed"));
		ws.onclose = () => {
			for (const w of pending.values())
				w.fail(new Error("browser link closed"));
			pending.clear();
		};
		ws.onopen = () =>
			resolve({
				send: (method, params, sessionId) =>
					new Promise((ok, fail) => {
						const id = nextId++;
						pending.set(id, { ok, fail });
						ws.send(JSON.stringify({ id, method, params, sessionId }));
					}),
				onEvent: (fn) => {
					listeners.push(fn);
				},
				close: () => ws.close(),
			});
	});

type Recorded = {
	chain: NavRecord[];
	loaded: boolean;
	blocked: number;
};

type ResponseInfo = { url?: string; status?: number; remoteIPAddress?: string };

const recordOf = (r: ResponseInfo, frame: unknown): NavRecord => ({
	url: r.url ?? "",
	status: r.status ?? null,
	remoteIp: r.remoteIPAddress ?? null,
	frame: typeof frame === "string" ? frame : null,
});

function trackNavigation(cdp: CdpConnection, sessionId: string): Recorded {
	const rec: Recorded = { chain: [], loaded: false, blocked: 0 };
	const answerPaused = (p: Record<string, unknown>) => {
		const request = (p.request ?? {}) as { url?: string };
		const requestId = String(p.requestId);
		if (allowRequest(request.url ?? "")) {
			void cdp
				.send("Fetch.continueRequest", { requestId }, sessionId)
				.catch(() => {});
			return;
		}
		rec.blocked += 1;
		void cdp
			.send(
				"Fetch.failRequest",
				{ requestId, errorReason: "AccessDenied" },
				sessionId,
			)
			.catch(() => {});
	};
	cdp.onEvent((m) => {
		if (m.sessionId !== sessionId) return;
		const p = m.params ?? {};
		if (m.method === "Page.loadEventFired") rec.loaded = true;
		else if (m.method === "Fetch.requestPaused") answerPaused(p);
		else if (m.method === "Network.responseReceived" && p.type === "Document")
			rec.chain.push(recordOf((p.response ?? {}) as ResponseInfo, p.frameId));
		else if (
			m.method === "Network.requestWillBeSent" &&
			p.type === "Document" &&
			p.redirectResponse
		)
			rec.chain.push(recordOf(p.redirectResponse as ResponseInfo, p.frameId));
	});
	return rec;
}

export type CaptureDeps = {
	launch?: Launcher;
	connect?: Connector;
	sleep?: (ms: number) => Promise<void>;
};

export async function captureScreenshot(
	install: BrowserInstall,
	url: string,
	deps: CaptureDeps = {},
): Promise<ShotResult> {
	const launch = deps.launch ?? spawnBrowser;
	const connect = deps.connect ?? connectWebSocket;
	const wait = deps.sleep ?? sleep;
	const launched = await launch(install);
	let cdp: CdpConnection | null = null;
	const overall = setTimeout(() => {
		void launched.stop();
	}, SHOT_LIMITS.totalMs);
	try {
		cdp = await connect(launched.wsUrl);
		return await drive(cdp, url, wait);
	} catch (e) {
		if (e instanceof ShotError) throw e;
		throw new ShotError(
			"failed",
			e instanceof Error ? e.message : "the browser failed",
		);
	} finally {
		clearTimeout(overall);
		cdp?.close();
		await launched.stop();
	}
}

async function drive(
	cdp: CdpConnection,
	url: string,
	wait: (ms: number) => Promise<void>,
): Promise<ShotResult> {
	const created = await cdp.send("Target.createTarget", { url: "about:blank" });
	const attached = await cdp.send("Target.attachToTarget", {
		targetId: created.targetId,
		flatten: true,
	});
	const sessionId = String(attached.sessionId);
	const rec = trackNavigation(cdp, sessionId);
	await cdp.send("Page.enable", {}, sessionId);
	await cdp.send("Network.enable", {}, sessionId);
	await cdp.send(
		"Fetch.enable",
		{ patterns: [{ urlPattern: "*" }] },
		sessionId,
	);
	await cdp.send(
		"Emulation.setDeviceMetricsOverride",
		{ ...SHOT_LIMITS.viewport, deviceScaleFactor: 1, mobile: false },
		sessionId,
	);
	const nav = await cdp.send("Page.navigate", { url }, sessionId);
	const mainFrame = typeof nav.frameId === "string" ? nav.frameId : null;
	if (typeof nav.errorText === "string" && nav.errorText !== "")
		throw new ShotError(
			rec.blocked > 0 ? "refused" : "failed",
			rec.blocked > 0
				? "the page tried to load a non-public address and was blocked"
				: `could not load the page: ${nav.errorText}`,
		);
	const deadline = SHOT_LIMITS.loadWaitMs;
	for (let waited = 0; !rec.loaded && waited < deadline; waited += 250) {
		await wait(250);
	}
	await wait(SHOT_LIMITS.settleMs);
	const main = mainFrame
		? rec.chain.filter((r) => r.frame === mainFrame)
		: rec.chain.slice(0, 1);
	verifyChain(rec.chain);
	const last = main.at(-1) ?? rec.chain[0];
	if (!last) throw new ShotError("failed", "the page never answered");
	const shot = await cdp.send(
		"Page.captureScreenshot",
		{ format: "png" },
		sessionId,
	);
	const png = Buffer.from(String(shot.data ?? ""), "base64");
	if (png.length < SHOT_LIMITS.minBytes)
		throw new ShotError("failed", "no image was produced");
	return {
		png,
		finalUrl: last.url,
		httpStatus: last.status,
		blockedRequests: rec.blocked,
	};
}
