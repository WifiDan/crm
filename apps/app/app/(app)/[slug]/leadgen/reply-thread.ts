/**
 * Pure helpers for the Replies tab: fold quoted history out of an email body,
 * and group several replies from one lead into one card.
 */

const QUOTE_START = [
	/^On .+wrote:\s*$/i, // Apple Mail / Gmail
	/^-{2,}\s*On .+ wrote\s*-{2,}\s*$/i, // Zoho "---- On ... wrote ----"
	/^From:\s.+/i, // Outlook-style header block
	/^Begin forwarded message:?\s*$/i,
	/^-{3,}\s*Original Message\s*-{3,}$/i,
	/^>/, // quoted line
];

export function splitQuoted(body: string | null | undefined): {
	latest: string;
	earlier: string;
} {
	const text = (body ?? "").replace(/\r\n/g, "\n");
	const lines = text.split("\n");
	const at = lines.findIndex((raw, i) => {
		const line = raw.trim();
		if (i === 0 || line === "") return false;
		if (QUOTE_START.some((re) => re.test(line))) return true;
		// Gmail wraps "On <date> <name>" and "wrote:" onto two lines.
		return (
			/^On .*\d{4}/.test(line) && /wrote:\s*$/.test(lines[i + 1]?.trim() ?? "")
		);
	});
	if (at < 0) return { latest: text.trim(), earlier: "" };
	return {
		latest: lines.slice(0, at).join("\n").trim(),
		earlier: lines.slice(at).join("\n").trim(),
	};
}

export type ThreadGroup<T> = { key: string; latest: T; older: T[] };

/** Newest first within a lead; groups ordered by their newest reply. */
export function groupByLead<
	T extends { lead: { id: string }; inbound: { receivedAt: string | null } },
>(items: readonly T[]): ThreadGroup<T>[] {
	const time = (item: T) =>
		item.inbound.receivedAt ? Date.parse(item.inbound.receivedAt) : 0;
	const byLead = new Map<string, T[]>();
	for (const item of items) {
		const list = byLead.get(item.lead.id) ?? [];
		list.push(item);
		byLead.set(item.lead.id, list);
	}
	return [...byLead.entries()]
		.map(([key, list]) => {
			const sorted = [...list].sort((a, b) => time(b) - time(a));
			const [latest, ...older] = sorted as [T, ...T[]];
			return { key, latest, older };
		})
		.sort((a, b) => time(b.latest) - time(a.latest));
}
