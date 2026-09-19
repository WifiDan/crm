/**
 * Attributes an inbound message to lead rows. Pure: takes prebuilt indexes, does no I/O.
 *
 * Order (strongest first), same as the live Python scanner:
 *   1. our own outbound Message-ID coming back in In-Reply-To/References
 *   2. the sender is an address we actually mailed
 *   3. the sender is a lead's own address AND the message is reply-shaped
 * Never a fuzzy name match. When several lead rows share one address, ALL of them are returned:
 * over-holding a sequence costs a pause, under-holding mails a pitch at someone mid-conversation.
 */

export type SendRef = {
	id: string;
	leadId: string;
	messageId: string | null;
	toAddr: string;
};
export type LeadRef = {
	id: string;
	email: string | null;
	nocodbRowId: number | null;
	doNotContact: boolean;
};
export type ContactRef = { leadId: string; value: string };

export type MatchIndexes = {
	sendsByMid: Map<string, SendRef>;
	leadIdsByToAddr: Map<string, Set<string>>;
	leadIdsByEmail: Map<string, Set<string>>;
	leadById: Map<string, LeadRef>;
};

export type LeadMatch = {
	leadIds: string[];
	method: "in_reply_to" | "send_log_email" | "lead_email" | null;
	matchedSendId: string | null;
};

export const norm = (s: string) => s.trim().toLowerCase();

function addTo(map: Map<string, Set<string>>, key: string, id: string) {
	const set = map.get(key) ?? new Set<string>();
	set.add(id);
	map.set(key, set);
}

export function buildMatchIndexes(
	sends: SendRef[],
	leads: LeadRef[],
	contacts: ContactRef[],
): MatchIndexes {
	const sendsByMid = new Map<string, SendRef>();
	const leadIdsByToAddr = new Map<string, Set<string>>();
	for (const s of sends) {
		if (s.messageId) sendsByMid.set(norm(s.messageId), s);
		addTo(leadIdsByToAddr, norm(s.toAddr), s.leadId);
	}
	const leadIdsByEmail = new Map<string, Set<string>>();
	for (const l of leads)
		if (l.email) addTo(leadIdsByEmail, norm(l.email), l.id);
	for (const c of contacts) addTo(leadIdsByEmail, norm(c.value), c.leadId);
	return {
		sendsByMid,
		leadIdsByToAddr,
		leadIdsByEmail,
		leadById: new Map(leads.map((l) => [l.id, l])),
	};
}

/** Deterministic order (NocoDB row id ascending) so "the" matched lead is stable between runs. */
function orderLeadIds(ids: Set<string>, idx: MatchIndexes): string[] {
	const row = (id: string) =>
		idx.leadById.get(id)?.nocodbRowId ?? Number.MAX_SAFE_INTEGER;
	return [...ids].sort((a, b) => row(a) - row(b) || a.localeCompare(b));
}

export function matchLeads(
	idx: MatchIndexes,
	msg: { fromAddr: string; subject: string; refs: string[] },
): LeadMatch {
	for (const ref of msg.refs) {
		const send = idx.sendsByMid.get(ref);
		if (send) {
			return {
				leadIds: [send.leadId],
				method: "in_reply_to",
				matchedSendId: send.id,
			};
		}
	}
	const sender = norm(msg.fromAddr);
	const mailed = idx.leadIdsByToAddr.get(sender);
	if (mailed) {
		return {
			leadIds: orderLeadIds(mailed, idx),
			method: "send_log_email",
			matchedSendId: null,
		};
	}
	const replyShaped = msg.refs.length > 0 || /^\s*re\s*:/i.test(msg.subject);
	const own = idx.leadIdsByEmail.get(sender);
	if (replyShaped && own) {
		return {
			leadIds: orderLeadIds(own, idx),
			method: "lead_email",
			matchedSendId: null,
		};
	}
	return { leadIds: [], method: null, matchedSendId: null };
}

export function describeMatch(m: LeadMatch): string | null {
	if (!m.method) return null;
	return m.leadIds.length > 1
		? `${m.method}(${m.leadIds.length} leads)`
		: m.method;
}
