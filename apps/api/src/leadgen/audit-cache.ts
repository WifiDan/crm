import { createHash, randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { AuditResult } from "./site-audit";

// Audits are small JSON documents, so the byte ceiling here is generous
// relative to file count; the file count is what actually bounds this cache.
export const AUDIT_CACHE = {
	ttlMs: 14 * 24 * 60 * 60 * 1000,
	maxFiles: 2000,
	maxBytes: 20 * 1024 * 1024,
} as const;

const LEAD_ID = /^[a-z0-9]{6,64}$/i;

export const AUDIT_NAME = /^[a-z0-9]{6,64}\.[a-f0-9]{10}\.json$/i;

export const isLeadId = (id: string) => LEAD_ID.test(id);

export const auditName = (leadId: string, url: string): string => {
	if (!isLeadId(leadId)) throw new Error("bad lead id");
	const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
	return `${leadId}.${hash}.json`;
};

export type CachedAudit = {
	result: AuditResult;
	capturedAt: Date;
	fresh: boolean;
};

export async function readAudit(
	dir: string,
	name: string,
	now: Date,
	ttlMs: number = AUDIT_CACHE.ttlMs,
): Promise<CachedAudit | null> {
	if (!AUDIT_NAME.test(name)) return null;
	const path = join(dir, name);
	try {
		const info = await lstat(path);
		if (!info.isFile()) return null;
		const raw = await readFile(path, "utf8");
		const result = JSON.parse(raw) as AuditResult;
		return {
			result,
			capturedAt: info.mtime,
			fresh: now.getTime() - info.mtime.getTime() < ttlMs,
		};
	} catch {
		return null;
	}
}

type Entry = { name: string; size: number; mtimeMs: number };

async function entries(dir: string): Promise<Entry[]> {
	const names = (await readdir(dir).catch(() => [] as string[])).filter((n) =>
		AUDIT_NAME.test(n),
	);
	const out: Entry[] = [];
	for (const name of names) {
		const info = await stat(join(dir, name)).catch(() => null);
		if (info?.isFile())
			out.push({ name, size: info.size, mtimeMs: info.mtimeMs });
	}
	return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export async function writeAudit(
	dir: string,
	name: string,
	result: AuditResult,
	limits: { maxFiles: number; maxBytes: number } = AUDIT_CACHE,
): Promise<string[]> {
	if (!AUDIT_NAME.test(name)) throw new Error("bad cache name");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const json = Buffer.from(JSON.stringify(result));
	const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(temp, json, { flag: "wx", mode: 0o600 });
		await rename(temp, join(dir, name));
	} catch (e) {
		await unlink(temp).catch(() => {});
		throw e;
	}
	const lead = name.slice(0, name.indexOf("."));
	const all = await entries(dir);
	const doomed = new Set(
		all
			.filter((e) => e.name !== name && e.name.startsWith(`${lead}.`))
			.map((e) => e.name),
	);
	let files = all.filter((e) => !doomed.has(e.name));
	let bytes = files.reduce((n, e) => n + e.size, 0);
	for (const e of files) {
		if (files.length <= limits.maxFiles && bytes <= limits.maxBytes) break;
		if (e.name === name) continue;
		doomed.add(e.name);
		files = files.filter((f) => f !== e);
		bytes -= e.size;
	}
	const removed: string[] = [];
	for (const victim of doomed) {
		await unlink(join(dir, victim)).then(
			() => removed.push(victim),
			() => {},
		);
	}
	return removed;
}
