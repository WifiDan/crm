/** Who replies are sent as. Pure config: no mail API, so it can be imported anywhere. */
export const LG_REPLY_IDENTITY = Symbol("LG_REPLY_IDENTITY");

export type ReplyIdentity = { address: string; fromName: string };

export function identityFromEnv(
	env: Record<string, string | undefined>,
): ReplyIdentity {
	return {
		address: (
			env.ZOHO_SMTP_USER ??
			env.ZOHO_IMAP_USER ??
			"danio@elitesystemsdesign.com"
		).toLowerCase(),
		fromName: env.LEADGEN_REPLY_FROM_NAME ?? "Danio - Elite Integration",
	};
}
