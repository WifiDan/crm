import { readFile } from "node:fs/promises";
import { norm } from "./reply-match";

/**
 * Read-side ports of the Python sender's suppression inputs (send_daily_batch.py, cards #335 and
 * #385). Phase 4 SHADOW only: the CRM computes what it WOULD send and compares that with what
 * Python actually sent. The behaviour is copied faithfully, including where it fails open, so a
 * mismatch means the port differs and not that the CRM is "better".
 */

const DIR = process.env.LEADGEN_PYTHON_DIR ?? "/data/leadgen/scripts";
export const REPLIED_FILE = `${DIR}/replied_leads.json`;
export const OPEN_STOPS_FILE = `${DIR}/stop_reply_open_reviews.json`;
export const STOP_STATE_FILE = `${DIR}/stop_reply_state.json`;

/** scan_stop_replies.py FREEMAIL_DOMAINS, which send_daily_batch.py imports. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"ymail.com",
	"hotmail.com",
	"outlook.com",
	"live.com",
	"msn.com",
	"aol.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"comcast.net",
	"att.net",
	"verizon.net",
	"protonmail.com",
	"proton.me",
	"gmx.com",
	"zoho.com",
	"sbcglobal.net",
	"bresnan.net",
	"charter.net",
	"centurylink.net",
	"q.com",
	"juno.com",
]);

export const STOP_SCAN_MAX_AGE_HOURS = 36;

export type RepliedHolds = {
	/** false = the file is missing or unreadable: Python holds ALL sends */
	ok: boolean;
	ids: Set<number>;
	addrs: Set<string>;
};

export type OpenStopHolds = { addrs: Set<string>; domains: Set<string> };

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const lower = (v: unknown) =>
	typeof v === "string" ? v.trim().toLowerCase() : "";

export function parseRepliedHolds(data: unknown): RepliedHolds {
	const empty = { ok: false, ids: new Set<number>(), addrs: new Set<string>() };
	if (!isObject(data) || !isObject(data.leads)) return empty;
	const ids = new Set<number>();
	const addrs = new Set<string>();
	for (const [key, raw] of Object.entries(data.leads)) {
		const info = isObject(raw) ? raw : {};
		if (info.released_at) continue; // a human answered this one; the sequence may resume
		const n = Number(key);
		if (Number.isInteger(n)) ids.add(n);
		const list = Array.isArray(info.reply_addresses)
			? info.reply_addresses
			: [];
		for (const a of [info.reply_from, ...list, info.mailed_address]) {
			const s = lower(a);
			if (s) addrs.add(s);
		}
	}
	return { ok: true, ids, addrs };
}

/** Python swallows every error here and holds nothing: a missing or broken file fails OPEN. */
export function parseOpenStops(data: unknown): OpenStopHolds {
	const addrs = new Set<string>();
	const domains = new Set<string>();
	if (!isObject(data)) return { addrs, domains };
	for (const info of Object.values(data)) {
		const addr = lower(isObject(info) ? info.from_email : "");
		if (!addr) continue;
		addrs.add(addr);
		const dom = addr.slice(addr.lastIndexOf("@") + 1);
		if (dom && !FREEMAIL_DOMAINS.has(dom)) domains.add(dom);
	}
	return { addrs, domains };
}

/** Hours since the STOP scan last completed, or null when it never did or the state is unreadable. */
export function stopScanAgeHours(state: unknown, now: Date): number | null {
	if (!isObject(state) || typeof state.last_run !== "string") return null;
	const t = new Date(state.last_run).getTime();
	return Number.isNaN(t) ? null : (now.getTime() - t) / 3_600_000;
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

export type PythonSendState = {
	stopAgeHours: number | null;
	replied: RepliedHolds;
	openStops: OpenStopHolds;
};

export async function loadPythonSendState(now: Date): Promise<PythonSendState> {
	const [stop, replied, open] = await Promise.all([
		readJson(STOP_STATE_FILE),
		readJson(REPLIED_FILE),
		readJson(OPEN_STOPS_FILE),
	]);
	return {
		stopAgeHours: stopScanAgeHours(stop, now),
		replied: parseRepliedHolds(replied),
		openStops: parseOpenStops(open),
	};
}

export { norm };
