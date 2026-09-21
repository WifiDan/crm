import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { stripBridge } from "./demo-bridge";

export const DEMO_LIMITS = {
	maxBytes: 8_000_000,
	minChars: 500,
	keepBackups: 10,
	maxReadBytes: 32_000_000,
} as const;

export const SLUG_PATTERN = /^[a-z0-9-]+$/;

export const BACKUP_PATTERN =
	/^index\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak\.html$/;

export type DemoFileCode =
	| "bad-slug"
	| "not-found"
	| "symlink"
	| "bad-path"
	| "outside"
	| "too-large"
	| "not-html"
	| "stale"
	| "io";

export class DemoFileError extends Error {
	constructor(
		readonly code: DemoFileCode,
		message: string,
	) {
		super(message);
		this.name = "DemoFileError";
	}
}

export const sha256Of = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

const inside = (root: string, candidate: string) =>
	candidate === root || candidate.startsWith(root + sep);

async function lstatOrNull(path: string) {
	try {
		return await lstat(path);
	} catch {
		return null;
	}
}

export async function resolveDemoDir(
	outputDir: string,
	slug: string,
): Promise<string> {
	if (!SLUG_PATTERN.test(slug))
		throw new DemoFileError("bad-slug", "slug is not allowed");
	let root: string;
	try {
		root = await realpath(outputDir);
	} catch {
		throw new DemoFileError("not-found", "demo output folder is missing");
	}
	const names = await readdir(root).catch(() => [] as string[]);
	if (!names.includes(slug))
		throw new DemoFileError("not-found", "no local build for this slug");
	const dir = join(root, slug);
	const stat = await lstatOrNull(dir);
	if (!stat)
		throw new DemoFileError("not-found", "no local build for this slug");
	if (stat.isSymbolicLink())
		throw new DemoFileError("symlink", "the demo folder is a symlink");
	if (!stat.isDirectory())
		throw new DemoFileError("not-found", "the demo path is not a folder");
	const real = await realpath(dir);
	if (real !== dir || !inside(root, real))
		throw new DemoFileError(
			"outside",
			"the demo folder resolves outside the output folder",
		);
	const index = await lstatOrNull(join(dir, "index.html"));
	if (!index || !index.isFile())
		throw new DemoFileError("not-found", "the demo has no index.html");
	return dir;
}

const SEGMENT_LIMIT = 200;

function checkSegment(segment: string): void {
	if (
		segment === "" ||
		segment === "." ||
		segment === ".." ||
		segment.length > SEGMENT_LIMIT ||
		segment.startsWith(".") ||
		/[\\/\0]/.test(segment)
	)
		throw new DemoFileError("bad-path", "path segment is not allowed");
	if (BACKUP_PATTERN.test(segment))
		throw new DemoFileError("bad-path", "backup files are not served");
}

export type DemoFile = { path: string; size: number; type: string };

export async function resolveDemoFile(
	dir: string,
	segments: string[],
): Promise<DemoFile> {
	const wanted = segments.length === 0 ? ["index.html"] : segments;
	for (const s of wanted) checkSegment(s);
	let current = dir;
	for (let i = 0; i < wanted.length; i++) {
		current = join(current, wanted[i] as string);
		const stat = await lstatOrNull(current);
		if (!stat) throw new DemoFileError("not-found", "not found");
		if (stat.isSymbolicLink())
			throw new DemoFileError("symlink", "symlinks are not served");
		const last = i === wanted.length - 1;
		if (last && stat.isDirectory()) {
			return resolveDemoFile(dir, [...wanted, "index.html"]);
		}
		if (last && !stat.isFile())
			throw new DemoFileError("not-found", "not a file");
		if (!last && !stat.isDirectory())
			throw new DemoFileError("not-found", "not a folder");
		if (last && stat.size > DEMO_LIMITS.maxReadBytes)
			throw new DemoFileError("too-large", "file is too large to serve");
	}
	const real = await realpath(current);
	if (!inside(dir, real) || real !== current)
		throw new DemoFileError("outside", "file resolves outside the demo folder");
	const stat = await lstat(real);
	return { path: real, size: stat.size, type: contentTypeOf(real) };
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg": "image/svg+xml",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml",
	".mp4": "video/mp4",
	".webm": "video/webm",
};

export function contentTypeOf(name: string): string {
	const dot = name.lastIndexOf(".");
	const ext = dot < 0 ? "" : name.slice(dot).toLowerCase();
	return TYPES[ext] ?? "application/octet-stream";
}

export const isHtmlType = (type: string) => type.startsWith("text/html");

export async function readDemoIndex(dir: string): Promise<{
	text: string;
	bytes: number;
	sha256: string;
	modifiedAt: Date;
}> {
	const path = join(dir, "index.html");
	const stat = await lstat(path);
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new DemoFileError("symlink", "index.html is not a regular file");
	if (stat.size > DEMO_LIMITS.maxReadBytes)
		throw new DemoFileError("too-large", "index.html is too large");
	const data = await readFile(path);
	return {
		text: data.toString("utf8"),
		bytes: data.byteLength,
		sha256: sha256Of(data),
		modifiedAt: stat.mtime,
	};
}

export type PreparedSave = {
	dir: string;
	slug: string;
	html: string;
	before: { bytes: number; sha256: string };
	after: { bytes: number; sha256: string };
	backupName: string;
};

export const backupNameFor = (now: Date) =>
	`index.${now.toISOString().replace(/[:.]/g, "-")}.bak.html`;

export async function prepareSave(input: {
	dir: string;
	html: string;
	expectedSha256: string;
	now: Date;
}): Promise<PreparedSave> {
	const html = stripBridge(input.html);
	if (html.includes("data-leadgen-bridge"))
		throw new DemoFileError(
			"not-html",
			"the editor bridge could not be removed",
		);
	if (html.length < DEMO_LIMITS.minChars || !/<html/i.test(html))
		throw new DemoFileError(
			"not-html",
			"not a full HTML document, refusing to save",
		);
	const bytes = Buffer.byteLength(html, "utf8");
	if (bytes > DEMO_LIMITS.maxBytes)
		throw new DemoFileError("too-large", "the page is larger than 8 MB");
	const current = await readDemoIndex(input.dir);
	if (current.sha256 !== input.expectedSha256)
		throw new DemoFileError(
			"stale",
			"the demo file changed since the page loaded",
		);
	return {
		dir: input.dir,
		slug: basename(input.dir),
		html,
		before: { bytes: current.bytes, sha256: current.sha256 },
		after: { bytes, sha256: sha256Of(html) },
		backupName: backupNameFor(input.now),
	};
}

export async function assertBackupOutsideOutput(
	outputDir: string,
	backupRoot: string,
): Promise<void> {
	const realOut = await realpath(outputDir).catch(() => resolve(outputDir));
	let probe = resolve(backupRoot);
	const tail: string[] = [];
	for (;;) {
		try {
			const real = await realpath(probe);
			const full = join(real, ...tail);
			if (inside(realOut, full))
				throw new DemoFileError(
					"outside",
					"the backup folder must not be inside the demo output folder",
				);
			return;
		} catch (e) {
			if (e instanceof DemoFileError) throw e;
			const parent = dirname(probe);
			if (parent === probe) return;
			tail.unshift(basename(probe));
			probe = parent;
		}
	}
}

export async function pruneBackups(
	slugBackupDir: string,
	keep: number,
): Promise<string[]> {
	const names = (await readdir(slugBackupDir).catch(() => [] as string[]))
		.filter((n) => BACKUP_PATTERN.test(n))
		.sort();
	const doomed = names.slice(0, Math.max(0, names.length - keep));
	const removed: string[] = [];
	for (const name of doomed) {
		const path = join(slugBackupDir, name);
		const stat = await lstatOrNull(path);
		if (!stat?.isFile()) continue;
		await unlink(path);
		removed.push(name);
	}
	return removed;
}

export async function commitSave(
	prepared: PreparedSave,
	backupRoot: string,
	keep: number = DEMO_LIMITS.keepBackups,
): Promise<{ backupPath: string; pruned: string[] }> {
	const slugBackups = join(backupRoot, prepared.slug);
	await mkdir(slugBackups, { recursive: true, mode: 0o700 });
	const backupPath = join(slugBackups, prepared.backupName);
	const indexPath = join(prepared.dir, "index.html");
	await copyFile(indexPath, backupPath, constants.COPYFILE_EXCL);
	const temp = join(
		prepared.dir,
		`.index.${randomBytes(6).toString("hex")}.tmp`,
	);
	try {
		await writeFile(temp, prepared.html, { flag: "wx", mode: 0o644 });
		await rename(temp, indexPath);
	} catch (e) {
		await unlink(temp).catch(() => {});
		throw e;
	}
	const pruned = await pruneBackups(slugBackups, keep);
	return { backupPath, pruned };
}
