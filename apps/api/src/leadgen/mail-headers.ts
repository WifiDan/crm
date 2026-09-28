/**
 * A single-header reader for the raw header blocks imapflow returns from a `headers` fetch
 * query (RFC 5322 lines, possibly folded across continuation lines). Pure, no I/O.
 */

/** Unfolds continuation lines (a header value that wraps onto lines starting with whitespace). */
function unfold(raw: string): string {
	return raw.replace(/\r?\n[ \t]+/g, " ");
}

/** Case-insensitive, returns the first match. `undefined` if the header is absent or headers is absent. */
export function headerValue(
	headers: Buffer | string | null | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const text = unfold(headers.toString("utf8"));
	const re = new RegExp(
		`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \t]*(.*)$`,
		"im",
	);
	return re.exec(text)?.[1]?.trim();
}
