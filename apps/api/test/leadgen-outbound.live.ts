import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@crm/db";
import {
	fetchPublic,
	OutboundRefusedError,
} from "../src/leadgen/outbound-guard";
import { LeadgenShotService } from "../src/leadgen/shot.service";
import {
	captureScreenshot,
	findBrowser,
	spawnBrowser,
} from "../src/leadgen/shot-browser";
import { scoreSite } from "../src/leadgen/site-audit";
import { SiteAuditService } from "../src/leadgen/site-audit.service";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
}
const PUBLIC_SITE = "https://elitesystemsdesign.com";
const ldBefore = process.env.LD_LIBRARY_PATH ?? "";

let hits = 0;
const trap = http.createServer((_req, res) => {
	hits++;
	res.end("you should never see this");
});
await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
const port = (trap.address() as { port: number }).port;

const opts = { maxBytes: 2_000_000, timeoutMs: 10_000 };
const refusedFor = async (url: string) => {
	const e = await fetchPublic(url, opts).catch((x) => x);
	return e instanceof OutboundRefusedError
		? e.message
		: `NOT REFUSED: ${String(e)}`;
};
for (const url of [
	`http://127.0.0.1:${port}/`,
	`http://localhost:${port}/`,
	`http://[::1]:${port}/`,
	"http://100.78.149.77:8768/",
	"http://169.254.169.254/latest/meta-data/",
	"http://joshua.tail261548.ts.net:8768/",
]) {
	const r = await refusedFor(url);
	check(
		`real resolver refuses ${url}`,
		r.startsWith("refused:"),
		r.slice(0, 90),
	);
}
const rebind = await refusedFor(`http://localtest.me:${port}/`);
check(
	"a real public name that resolves to 127.0.0.1 (localtest.me) is refused, trap server got 0 hits",
	rebind.startsWith("refused:") && hits === 0,
	rebind.slice(0, 100),
);
check("loopback trap server saw no request at all", hits === 0, `hits=${hits}`);

const site = await fetchPublic(PUBLIC_SITE, opts);
check(
	"one public URL fetches through the pinned transport",
	site.status === 200 && site.text.length > 500,
	`status=${site.status} bytes=${site.text.length}`,
);
const plain = await fetchPublic("http://elitesystemsdesign.com", opts);
check(
	"a real redirect (http to https) is followed and reported",
	plain.finalUrl.startsWith("https://") && plain.hops >= 1,
	`hops=${plain.hops} final=${plain.finalUrl}`,
);
const audit = await new SiteAuditService({
	lgLead: { findFirst: async () => ({ websiteUrl: PUBLIC_SITE }) },
} as unknown as Db).run("x");
check(
	"the audit service scores the public site like the pure function",
	JSON.stringify(audit) ===
		JSON.stringify(scoreSite(site.text, `${PUBLIC_SITE}/`)) &&
		audit.priority !== "Error",
	`${audit.priority} ${audit.score}`,
);
console.log("     audit:", JSON.stringify(audit));

const install = findBrowser();
check("the browser install is found", install !== null, install?.binary ?? "");
const cacheDir = mkdtempSync(join(tmpdir(), "shots-live-"));
const svc = new LeadgenShotService(
	{
		lgLead: { findFirst: async () => ({ websiteUrl: PUBLIC_SITE }) },
	} as unknown as Db,
	{ cacheDir },
);
const t0 = Date.now();
const shot = await svc.capture("liveleadid1", false);
const png = (await svc.image("liveleadid1"))?.png;
const pngOk =
	!!png && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
check(
	"a real screenshot of the public site is a PNG in the cache",
	pngOk && shot.fromCache === false && shot.bytes > 10_000,
	`bytes=${shot.bytes} status=${shot.httpStatus} final=${shot.finalUrl} ${Date.now() - t0}ms`,
);
const again = await svc.capture("liveleadid1", false);
check("the second call is served from the cache", again.fromCache === true);
console.log("     cache files:", readdirSync(cacheDir).join(","));
if (png)
	(await import("node:fs")).writeFileSync(
		join(cacheDir, "..", "shot-live-sample.png"),
		png,
	);

const dead = new LeadgenShotService(
	{
		lgLead: {
			findFirst: async () => ({
				websiteUrl: "https://nonexistent-host-for-test.invalid/",
			}),
		},
	} as unknown as Db,
	{ cacheDir },
);
const deadErr = await dead.capture("liveleadid2", false).catch((e) => e);
check(
	"a site that does not exist is an error, and no picture of the browser's error page is cached",
	deadErr instanceof Error &&
		!readdirSync(cacheDir).some((n) => n.startsWith("liveleadid2")),
	String(deadErr?.message).slice(0, 110),
);

if (install) {
	const direct = await captureScreenshot(
		install,
		`http://127.0.0.1:${port}/`,
	).catch((e) => e);
	check(
		"the real browser, pointed straight at loopback (guard bypassed), refuses to load it and takes no picture",
		direct instanceof Error && hits === 0,
		`${direct?.name}: ${String(direct?.message).slice(0, 110)} hits=${hits}`,
	);
	const tail = await captureScreenshot(
		install,
		"http://100.78.149.77:8768/",
	).catch((e) => e);
	check(
		"the real browser is blocked from the tailnet address too",
		tail instanceof Error,
		String(tail?.message).slice(0, 110),
	);
}

check(
	"LD_LIBRARY_PATH of this process was never changed",
	(process.env.LD_LIBRARY_PATH ?? "") === ldBefore,
);
trap.close();
rmSync(cacheDir, { recursive: true, force: true });
const running = () => {
	try {
		return execFileSync("pgrep", ["-x", "chrome-headless"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "";
	}
};
if (install) {
	const control = await spawnBrowser(install);
	await new Promise((r) => setTimeout(r, 300));
	check(
		"control: the process check can see a running browser",
		running() !== "",
		running().replace(/\n/g, ","),
	);
	await control.stop();
}
await new Promise((r) => setTimeout(r, 500));
check("no browser process is left running", running() === "", running());
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
