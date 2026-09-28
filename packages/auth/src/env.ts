import "@crm/env/load";
import {
	toZohoRegion,
	type ZohoEndpoints,
	type ZohoRegion,
	zohoEndpoints,
} from "./zoho-region";

const DEFAULT_API_URL = "http://localhost:3001";
const DEFAULT_APP_URL = "http://localhost:3000";
const DEFAULT_MICROSOFT_TENANT = "common";

const optional = (key: string): string | undefined => {
	const value = process.env[key];
	return value && value.length > 0 ? value : undefined;
};

const pair = (
	idKey: string,
	secretKey: string,
): { clientId: string; clientSecret: string } | undefined => {
	const clientId = optional(idKey);
	const clientSecret = optional(secretKey);

	if (!clientId || !clientSecret) {
		if (clientId || clientSecret) {
			throw new Error(`${idKey} and ${secretKey} must be set together.`);
		}
		return undefined;
	}

	return { clientId, clientSecret };
};

const googleCredentials = ():
	| { clientId: string; clientSecret: string }
	| undefined => pair("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");

const microsoftCredentials = ():
	| { clientId: string; clientSecret: string; tenantId: string }
	| undefined => {
	const credentials = pair("MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET");
	if (!credentials) return undefined;

	return {
		...credentials,
		tenantId: optional("MICROSOFT_TENANT_ID") ?? DEFAULT_MICROSOFT_TENANT,
	};
};

const zohoCredentials = ():
	| {
			clientId: string;
			clientSecret: string;
			region: ZohoRegion;
			endpoints: ZohoEndpoints;
	  }
	| undefined => {
	const credentials = pair("ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET");
	if (!credentials) return undefined;

	const region = toZohoRegion(optional("ZOHO_REGION"));

	return { ...credentials, region, endpoints: zohoEndpoints(region) };
};

const slackCredentials = ():
	| { clientId: string; clientSecret: string }
	| undefined => pair("SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET");

const apiUrl =
	optional("API_URL") ?? optional("BETTER_AUTH_URL") ?? DEFAULT_API_URL;

const appUrls = (optional("APP_URL") ?? DEFAULT_APP_URL)
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const appUrl = appUrls[0] ?? DEFAULT_APP_URL;

// Whether the session cookie carries the Secure flag and the __Secure- name
// prefix. This must be derived from the URL scheme, never from NODE_ENV: the
// API and the Next app are separate processes, and `next start` forces
// NODE_ENV=production while a plain `bun dist/main.js` does not. When the two
// disagree, one process writes `crm.session_token` and the other looks for
// `__Secure-crm.session_token`, so a perfectly good sign-in reads as "no
// session" and bounces back to /sign-in. The scheme is the same for both.
const secureCookies = (): boolean => {
	const override = optional("AUTH_SECURE_COOKIES");
	if (override) return override !== "false" && override !== "0";

	return apiUrl.startsWith("https://");
};

export const env = {
	apiUrl,
	appUrl,
	google: googleCredentials(),
	microsoft: microsoftCredentials(),
	slack: slackCredentials(),
	zoho: zohoCredentials(),
	cookieDomain: optional("AUTH_COOKIE_DOMAIN"),
	trustedOrigins: [...new Set([...appUrls, apiUrl])],
	isProduction: process.env.NODE_ENV === "production",
	secureCookies: secureCookies(),
} as const;

export function isGoogleConfigured(): boolean {
	return env.google !== undefined;
}

export function isMicrosoftConfigured(): boolean {
	return env.microsoft !== undefined;
}

export function isSlackConfigured(): boolean {
	return env.slack !== undefined;
}

export function isZohoConfigured(): boolean {
	return env.zoho !== undefined;
}

export { apiUrl, appUrl };

export function zohoConfig() {
	return env.zoho;
}
