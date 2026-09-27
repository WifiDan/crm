const LOGO_LINK_BASE = "https://logos.context.dev/";

export type CompanyLogoInput = {
	iconUrl?: string | null;
	logoUrl?: string | null;
	iconDarkUrl?: string | null;
	logoDarkUrl?: string | null;
	domain?: string | null;
};

function logoLinkUrl(
	domain: string,
	options?: { theme?: "dark"; type?: "icon" | "wordmark" },
): string | null {
	// Off by default: the feature only turns on once this is set (Card #?,
	// Context.dev Logo Link — 100k calls/mo, separate from the paused
	// Context.dev API credits on Card #564).
	const clientId = process.env.NEXT_PUBLIC_CONTEXT_DEV_LOGO_CLIENT_ID;
	if (!clientId) return null;

	const params = new URLSearchParams({ publicClientId: clientId, domain });
	if (options?.theme) params.set("theme", options.theme);
	if (options?.type) params.set("type", options.type);

	return `${LOGO_LINK_BASE}?${params.toString()}`;
}

/** True for a src this module generated from Context.dev Logo Link, as
 * opposed to a stored icon/logo URL. */
export function isLogoLinkSrc(src: string | null | undefined): boolean {
	return !!src && src.startsWith(LOGO_LINK_BASE);
}

/** Stored icon/logo first. Falls back to the Context.dev Logo Link icon when
 * the company has no stored logo of its own but does have a domain — and
 * only when the feature is enabled via NEXT_PUBLIC_CONTEXT_DEV_LOGO_CLIENT_ID.
 * Returns null (no image, initials shown) when neither is available. */
export function companyLogoSrc(company: CompanyLogoInput): string | null {
	const stored = company.iconUrl ?? company.logoUrl ?? null;
	if (stored) return stored;
	if (!company.domain) return null;
	return logoLinkUrl(company.domain);
}

/** Same fallback for the dark-theme slot: stored dark icon first, else the
 * Logo Link dark variant when there's no stored dark icon. */
export function companyLogoDarkSrc(company: CompanyLogoInput): string | null {
	const storedDark = company.iconDarkUrl ?? company.logoDarkUrl ?? null;
	if (storedDark) return storedDark;
	if (!company.domain) return null;
	return logoLinkUrl(company.domain, { theme: "dark" });
}
