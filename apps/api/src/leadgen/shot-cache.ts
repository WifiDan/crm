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

export const SHOT_CACHE = {
	ttlMs: 14 * 24 * 60 * 60 * 1000,
	maxFiles: 400,
	maxBytes: 300 * 1024 * 1024,
	forceMinAgeMs: 60_000,
} as const;

const LEAD_ID = /^[a-z0-9]{6,64}$/i;

export const SHOT_NAME = /^[a-z0-9]{6,64}\.[a-f0-9]{10}\.png$/i;

export const isLeadId = (id: string) => LEAD_ID.test(id);

export const shotName = (leadId: string, url: string): string => {
	if (!isLeadId(leadId)) throw new Error("bad lead id");
	const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
	return `${leadId}.${hash}.png`;
};

export type CachedShot = { png: Buffer; capturedAt: Date; fresh: boolean };

export async function readShot(
	dir: string,
	name: string,
	now: Date,
	ttlMs: number = SHOT_CACHE.ttlMs,
): Promise<CachedShot | null> {
	if (!SHOT_NAME.test(name)) return null;
	const path = join(dir, name);
	try {
		const info = await lstat(path);
		if (!info.isFile()) return null;
		const png = await readFile(path);
		return {
			png,
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
		SHOT_NAME.test(n),
	);
	const out: Entry[] = [];
	for (const name of names) {
		const info = await stat(join(dir, name)).catch(() => null);
		if (info?.isFile())
			out.push({ name, size: info.size, mtimeMs: info.mtimeMs });
	}
	return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export async function writeShot(
	dir: string,
	name: string,
	png: Buffer,
	limits: { maxFiles: number; maxBytes: number } = SHOT_CACHE,
): Promise<string[]> {
	if (!SHOT_NAME.test(name)) throw new Error("bad cache name");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(temp, png, { flag: "wx", mode: 0o600 });
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
