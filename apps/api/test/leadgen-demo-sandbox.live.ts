import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoPreviewService } from "../src/leadgen/demo-preview.service";
import { findBrowser } from "../src/leadgen/shot-browser";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
}

const NAIVE = process.env.SANDBOX_NAIVE === "1";
const install = findBrowser();
if (!install) {
	console.error("no browser installed");
	process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "sandbox-live-"));
const outputDir = join(root, "output");
const SLUG = "sandbox-demo";
mkdirSync(join(outputDir, SLUG, "assets"), { recursive: true });
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
writeFileSync(join(outputDir, SLUG, "assets", "pixel.png"), PIXEL);
writeFileSync(
	join(outputDir, SLUG, "assets", "style.css"),
	".probe{color:rgb(1,2,3)}",
);
writeFileSync(
	join(outputDir, SLUG, "index.html"),
	`<!doctype html><html><head><title>Sandbox probe</title><link rel="stylesheet" href="assets/style.css"></head>
<body><p class="probe" id="p">${"padding text ".repeat(40)}</p><img id="i" src="assets/pixel.png">
<script>
var r = {};
function t(name, fn) { try { r[name] = String(fn()); } catch (e) { r[name] = "ERR:" + e.name; } }
t("cookie", function () { return document.cookie; });
t("localStorage", function () { return localStorage.length; });
t("parentDocument", function () { return parent.document.body.innerHTML.length; });
t("topLocation", function () { return top.location.href; });
t("origin", function () { return self.origin; });
window.addEventListener("load", function () {
  r.image = document.getElementById("i").naturalWidth > 0 ? "loaded" : "failed";
  r.css = getComputedStyle(document.getElementById("p")).color;
  var done = function () { parent.postMessage({ probe: r }, "*"); };
  try { fetch("/secret", { credentials: "include" }).then(function (x) { r.fetch = "OK:" + x.status; }).catch(function (e) { r.fetch = "ERR:" + e.name; }).then(done); }
  catch (e) { r.fetch = "THROW:" + e.name; done(); }
});
</script></body></html>`,
);
writeFileSync(join(root, "secret-note.txt"), "not served");

const dirs = { outputDir, backupDir: join(root, "backups") };
const key = Buffer.alloc(32, 9);
const previews = new DemoPreviewService(key, dirs, () => new Date());
const link = previews.mint(SLUG, "edit");

const hits: string[] = [];
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		hits.push(
			`${req.method} ${url.pathname} cookie=${req.headers.get("cookie") ? "sent" : "none"}`,
		);
		if (url.pathname === "/parent.html") {
			return new Response(
				`<!doctype html><html><body><script>document.cookie = "crm_session=SECRET123; path=/";</script>
<iframe id="f" sandbox="${NAIVE ? "allow-scripts allow-same-origin" : "allow-scripts"}" src="${link.path}" style="width:600px;height:400px"></iframe><pre id="out">waiting</pre>
<script>
var f = document.getElementById("f"), out = {};
try { out.parentSeesFrameDocument = String(!!f.contentDocument); } catch (e) { out.parentSeesFrameDocument = "ERR:" + e.name; }
var edited = "";
window.addEventListener("message", function (e) {
  if (e.source !== f.contentWindow) { out.foreign = "message from a foreign source"; return; }
  var d = e.data || {};
  if (d.probe) out.probe = d.probe;
  if (d.leadgen === 1 && d.type === "ready") {
    f.contentWindow.postMessage({ leadgen: 1, type: "edit", on: true }, "*");
    setTimeout(function () { f.contentWindow.postMessage({ leadgen: 1, type: "get-html", nonce: "n-1" }, "*"); }, 300);
  }
  if (d.leadgen === 1 && d.type === "edit-state") out.editState = d.on;
  if (d.leadgen === 1 && d.type === "html") { out.htmlNonce = d.nonce; out.htmlHasBridge = String(d.html.indexOf("data-leadgen-bridge") >= 0); out.htmlHasPage = String(d.html.indexOf("Sandbox probe") >= 0); out.htmlStart = d.html.slice(0, 15); }
});
setTimeout(function () { document.getElementById("out").textContent = JSON.stringify(out); }, 3000);
</script></body></html>`,
				{ headers: { "content-type": "text/html" } },
			);
		}
		if (url.pathname.startsWith("/api/leadgen/demo-preview/")) {
			const served = await previews.serve(
				url.pathname.slice("/api/leadgen/demo-preview/".length),
			);
			const headers = { ...served.headers };
			if (NAIVE)
				delete (headers as Record<string, string>)["Content-Security-Policy"];
			return new Response(served.body, { status: served.status, headers });
		}
		if (url.pathname === "/secret")
			return new Response("secret data", {
				headers: { "access-control-allow-origin": "*" },
			});
		return new Response("nope", { status: 404 });
	},
});

const env = {
	PATH: "/usr/bin:/bin",
	HOME: root,
	LD_LIBRARY_PATH: install.libDirs.join(":"),
	LANG: "C.UTF-8",
};
const dom = await new Promise<string>((resolve, reject) => {
	const child = spawn(
		install.binary,
		[
			"--headless",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			`--user-data-dir=${join(root, "profile")}`,
			"--virtual-time-budget=8000",
			"--dump-dom",
			`http://127.0.0.1:${server.port}/parent.html`,
		],
		{
			env: env as unknown as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	let out = "";
	child.stdout.on("data", (c: Buffer) => {
		out += c.toString();
	});
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		reject(new Error("browser timed out"));
	}, 40_000);
	child.on("exit", () => {
		clearTimeout(timer);
		resolve(out);
	});
});

const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
const text = (m?.[1] ?? "")
	.replace(/&quot;/g, '"')
	.replace(/&lt;/g, "<")
	.replace(/&gt;/g, ">")
	.replace(/&amp;/g, "&");
let result: Record<string, unknown> = {};
try {
	result = JSON.parse(text);
} catch {
	console.log("could not read the result from the page:", text.slice(0, 300));
}
const probe = (result.probe ?? {}) as Record<string, string>;
console.log("     result:", JSON.stringify(result));
console.log("     server saw:", hits.join(" | "));

check("the page ran and reported", typeof result.probe === "object");
check(
	"the demo's script cannot read document.cookie",
	probe.cookie?.startsWith("ERR:SecurityError") === true,
	probe.cookie,
);
check(
	"the demo's script cannot reach localStorage",
	probe.localStorage?.startsWith("ERR:SecurityError") === true,
	probe.localStorage,
);
check(
	"the demo's script cannot read the parent (CRM) document",
	probe.parentDocument?.startsWith("ERR:SecurityError") === true,
	probe.parentDocument,
);
check(
	"the demo's script cannot navigate or read the top window",
	probe.topLocation?.startsWith("ERR:SecurityError") === true,
	probe.topLocation,
);
check(
	"the demo runs in an opaque origin",
	probe.origin === "null",
	probe.origin,
);
check(
	"the demo's fetch to the CRM origin is blocked by connect-src",
	probe.fetch?.startsWith("ERR:") === true &&
		!hits.some((h) => h.startsWith("GET /secret")),
	`${probe.fetch}; server saw /secret: ${hits.some((h) => h.includes("/secret"))}`,
);
check(
	"the parent cannot read the frame's document",
	String(result.parentSeesFrameDocument).startsWith("ERR:SecurityError") ||
		result.parentSeesFrameDocument === "false" ||
		result.parentSeesFrameDocument === "null",
	String(result.parentSeesFrameDocument),
);
check(
	"the image asset loads inside the opaque-origin frame (CORP cross-origin)",
	probe.image === "loaded",
	probe.image,
);
check(
	"the stylesheet asset loads and applies",
	probe.css === "rgb(1, 2, 3)",
	probe.css,
);
check(
	"asset requests carried no cookie (a cookie-only route would have failed)",
	hits
		.filter((h) => h.includes("/assets/"))
		.every((h) => h.endsWith("cookie=none")) &&
		hits.some((h) => h.includes("/assets/")),
	hits.filter((h) => h.includes("/assets/")).join(", "),
);
check(
	"the bridge announced itself and edit mode turned on",
	result.editState === true,
	String(result.editState),
);
check(
	"get-html came back with the caller's nonce, the page, and no bridge",
	result.htmlNonce === "n-1" &&
		result.htmlHasPage === "true" &&
		result.htmlHasBridge === "false" &&
		result.htmlStart === "<!doctype html>",
	JSON.stringify([
		result.htmlNonce,
		result.htmlHasPage,
		result.htmlHasBridge,
		result.htmlStart,
	]),
);
check("no foreign-source message was accepted", result.foreign === undefined);

server.stop(true);
rmSync(root, { recursive: true, force: true });
await new Promise((r) => setTimeout(r, 500));
let left = "";
try {
	left = execFileSync("pgrep", ["-x", "chrome-headless"], {
		encoding: "utf8",
	}).trim();
} catch {
	left = "";
}
check("no browser process is left running", left === "", left);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
