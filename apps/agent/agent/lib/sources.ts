import { db, EnrichmentStatus } from "@crm/db";
import { defineState } from "eve/context";
import { settle } from "./enrichment";
import { type Evidence, needsFetchedSource } from "./evidence";
import { currentFocus } from "./focus";
import { completeTask } from "./tasks";

/**
 * Provenance for one research session.
 *
 * A model that cannot read a source will happily invent one, and an invented
 * firmographic reads exactly like a real one. So the runtime — not the prompt —
 * keeps the list of pages this session actually retrieved, and a write that
 * cites anything else is refused.
 */

const MAX_SOURCES = 200;

export type SourceBlock = {
	reason: string;
	url: string | null;
};

type SourceState = {
	hosts: string[];
	urls: string[];
	blocked: SourceBlock | null;
};

const sources = defineState(
	"crm.sources",
	(): SourceState => ({ hosts: [], urls: [], blocked: null }),
);

/** The host a URL belongs to, lowercased and without `www.`, or null. */
export function hostOf(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;

	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return null;

	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.length === 0 || !host.includes(".")) return null;

	return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Pure host comparison, so the rule can be tested without a session.
 * A cited page counts when it sits on a host we actually read, or on a
 * subdomain of one — an extract crawls a site, not a single URL.
 */
export function hostMatches(cited: string, fetched: string): boolean {
	return (
		cited === fetched ||
		cited.endsWith(`.${fetched}`) ||
		fetched.endsWith(`.${cited}`)
	);
}

export function citesFetchedHost(
	sourceUrl: string | null | undefined,
	fetched: readonly string[],
): boolean {
	const host = hostOf(sourceUrl);
	if (!host) return false;

	return fetched.some((entry) => hostMatches(host, entry));
}

function read(): SourceState | null {
	try {
		return sources.get();
	} catch {
		return null;
	}
}

function write(fn: (current: SourceState) => SourceState): void {
	try {
		sources.update(fn);
	} catch {
		// No eve context — nothing to record. Reads fail closed anyway.
	}
}

/** Called wherever a page is genuinely retrieved. Never by the model. */
export function recordFetchedSource(url: string | null | undefined): void {
	const host = hostOf(url);
	if (!host) return;

	const full = (url ?? "").trim();

	write((current) => ({
		...current,
		hosts: current.hosts.includes(host)
			? current.hosts
			: [...current.hosts, host].slice(-MAX_SOURCES),
		urls: current.urls.includes(full)
			? current.urls
			: [...current.urls, full].slice(-MAX_SOURCES),
	}));
}

export function recordFetchedSources(
	urls: readonly (string | null | undefined)[],
): void {
	for (const url of urls) recordFetchedSource(url);
}

/** Hosts this session has actually read. */
export function fetchedHosts(): string[] {
	return read()?.hosts ?? [];
}

export function fetchedUrls(): string[] {
	return read()?.urls ?? [];
}

/**
 * Latch the session shut for writes. Set only when a source the task depends
 * on could not be retrieved, so nothing downstream can be written from nothing.
 */
export function blockWrites(reason: string, url: string | null = null): void {
	write((current) => ({
		...current,
		blocked: current.blocked ?? { reason, url },
	}));
}

export function writesBlocked(): SourceBlock | null {
	return read()?.blocked ?? null;
}

export type SourceVerdict =
	| { ok: true; sourceUrl: string; host: string }
	| { ok: false; reason: string };

/**
 * The gate every field write goes through: refuse unless `sourceUrl` names a
 * page this session actually fetched.
 */
export function verifySource(
	sourceUrl: string | null | undefined,
): SourceVerdict {
	const blocked = writesBlocked();
	if (blocked) {
		return {
			ok: false,
			reason: `${verifySourceReason(blocked)} Stop here rather than writing anything you have not read.`,
		};
	}

	const hosts = fetchedHosts();

	if (hosts.length === 0) {
		return {
			ok: false,
			reason:
				"Nothing has been fetched in this session, so there is no source to cite. " +
				"Read the source first (research_company, enrich_company, or a search that returns the page), then write. Leave the field blank rather than guess.",
		};
	}

	const cited = sourceUrl?.trim();
	if (!cited) {
		return {
			ok: false,
			reason:
				"sourceUrl is required: give the page you read this value on. " +
				`Pages read in this session: ${hosts.join(", ")}.`,
		};
	}

	const host = hostOf(cited);

	if (!host) {
		return {
			ok: false,
			reason: `"${cited}" is not a URL. Give the address of the page you read this value on.`,
		};
	}

	if (!hosts.some((entry) => hostMatches(host, entry))) {
		return {
			ok: false,
			reason:
				`Refused: nothing on ${host} was fetched in this session, so that citation cannot be checked. ` +
				`Pages actually read here: ${hosts.join(", ")}. ` +
				"Cite one of those, or leave the field blank — never a URL you have not opened.",
		};
	}

	return { ok: true, sourceUrl: cited, host };
}

/**
 * The same gate for a brief, which cites its evidence item by item. Evidence
 * drawn from our own CRM stands on its own; anything that names an outside
 * page must name one this session read.
 */
export function verifyEvidence(input: {
	evidence: readonly Evidence[];
	sourceUrl?: string | null;
}): { ok: true } | { ok: false; reason: string } {
	const blocked = writesBlocked();
	if (blocked) return { ok: false, reason: verifySourceReason(blocked) };

	if (input.sourceUrl) {
		const verdict = verifySource(input.sourceUrl);
		if (!verdict.ok) return { ok: false, reason: verdict.reason };
	}

	const external = input.evidence.filter((item) =>
		needsFetchedSource(item.kind),
	);

	if (external.length === 0) return { ok: true };

	for (const item of external) {
		const cited = item.sourceUrl ?? input.sourceUrl ?? null;
		const verdict = verifySource(cited);

		if (!verdict.ok) {
			return {
				ok: false,
				reason: `Evidence "${item.kind}" cannot stand: ${verdict.reason}`,
			};
		}
	}

	return { ok: true };
}

function verifySourceReason(blocked: SourceBlock): string {
	return (
		`Source unavailable${blocked.url ? ` (${blocked.url})` : ""}: ${blocked.reason} ` +
		"Nothing more can be written on this record in this session."
	);
}

/**
 * A source the task depends on could not be read.
 *
 * When the unreadable page belongs to the record this task is about, the task
 * cannot be done: it is closed through the same path everything else closes
 * through (completeTask + settle), and the session is latched shut so nothing
 * downstream can be written from nothing. When it belongs to some other record
 * — a contact's employer during an `identify`, say — the task carries on, and
 * the per-write source check is what keeps it honest.
 */
export async function failForMissingSource(input: {
	url: string;
	reason: string;
	companyId?: string | null;
	contactId?: string | null;
}): Promise<{ outcome: string; taskClosed: boolean }> {
	const outcome = `Source unavailable — ${input.url} could not be read (${input.reason}). Nothing was written.`;

	const { sessionId } = currentFocus();
	if (!sessionId) return { outcome, taskClosed: false };

	const task = await db.agentTask.findFirst({
		where: { sessionId, finishedAt: null },
		select: { id: true, companyId: true, contactId: true },
	});

	if (!task) return { outcome, taskClosed: false };

	const ownsSubject =
		(input.companyId != null && task.companyId === input.companyId) ||
		(input.contactId != null && task.contactId === input.contactId);

	if (!ownsSubject) return { outcome, taskClosed: false };

	blockWrites(input.reason, input.url);

	const subject = await completeTask(task.id, outcome);
	if (subject) {
		await settle(
			subject,
			EnrichmentStatus.FAILED,
			`${input.url} could not be read: ${input.reason}`,
		);
	}

	return { outcome, taskClosed: true };
}
