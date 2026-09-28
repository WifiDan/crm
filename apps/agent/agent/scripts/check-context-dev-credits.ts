// Card #564, 2026-09-26. Daily credit-balance check so the Context.dev plan
// can't be silently exhausted again the way it was this time (an inbound
// email was the ONLY signal, discovered after the fact).
//
// Builds its OWN client directly from the raw stored key rather than going
// through contextDev()/contextDevKey() in ../lib/capabilities.ts -- that pair
// honors CONTEXT_DEV_PAUSED (this same card's pause fix) and returns null
// while paused, which made a first version of this script always report "ok"
// (a skipped-because-gated result looks identical in shape to a
// skipped-because-no-brand-matched result unless you read the reason text).
// This check exists specifically to see PAST that gate, so it can catch the
// moment credits actually reset during the pause -- Danio's decision was
// "pause until the monthly reset", and this is how anyone finds out that
// happened without waiting for a human to notice, same as last time.
//
// Uses a real, minimal, billable lookup (brandByDomain-equivalent against a
// throwaway, never-cached domain) rather than verifyKey()'s free auth-only
// probe -- tested live 2026-09-26 while the account was actually exhausted:
// the free probe reported "valid" (auth succeeds independently of credit
// balance) and a lookup against a COMMON domain (stripe.com) came back
// "skipped, no brand matched" (evidently served from a cross-account cache,
// not billed, not a real signal either) -- only a lookup against a domain
// that can't already be cached actually forces a fresh, billable attempt and
// surfaced the real "401 USAGE_EXCEEDED" error. A failed USAGE_EXCEEDED call
// is not billed (there is nothing left to bill), so running this daily while
// paused costs nothing extra; once credits reset, the daily lookup itself
// becomes the one call/day that proves it and costs exactly one real credit
// to do so.
import ContextDev from "context.dev";
import { APIError } from "context.dev/core/error";
import { db } from "@crm/db";
import { readContextDevKey } from "@crm/db/settings";

const key = await readContextDevKey(db);
if (!key) {
	console.log(JSON.stringify({ state: "no_key", detail: "no Context.dev key stored" }));
	process.exit(0);
}

const api = new ContextDev({ apiKey: key });
// A fresh, never-cached domain on every run -- the whole point is to force a
// real lookup attempt, not serve a cached (and therefore uninformative) hit.
const probeDomain = `credit-probe-${Date.now()}.elitesystemsdesign.com`;

try {
	await api.brand.retrieve({ type: "by_domain", domain: probeDomain, timeoutMS: 15000 });
	// A domain this specific will never actually resolve to a real brand, so
	// reaching here (no error at all) would itself be unexpected -- still "ok",
	// just worth being honest that this shape wasn't observed in testing.
	console.log(JSON.stringify({ state: "ok", detail: "lookup succeeded (unexpected but fine)" }));
} catch (error) {
	if (!(error instanceof APIError)) {
		console.log(JSON.stringify({ state: "error", detail: String(error) }));
		process.exit(0);
	}

	const body = error.error as { error_code?: string; message?: string } | undefined;
	const code = body?.error_code;
	const detail = `${error.status ?? "?"} ${code ?? error.message}`;

	if (code === "NOT_FOUND" || code === "WEBSITE_ACCESS_ERROR") {
		// Real, expected outcome for a domain that doesn't exist -- proves the
		// account IS able to attempt fresh lookups right now.
		console.log(JSON.stringify({ state: "ok", detail }));
	} else if (/USAGE_EXCEEDED/i.test(detail)) {
		console.log(JSON.stringify({ state: "exhausted", detail }));
	} else if (error.status === 401 || error.status === 403) {
		console.log(JSON.stringify({ state: "key_invalid", detail }));
	} else {
		console.log(JSON.stringify({ state: "error", detail }));
	}
}
process.exit(0);
