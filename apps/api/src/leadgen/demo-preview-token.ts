import { createHmac, timingSafeEqual } from "node:crypto";

export type PreviewMode = "view" | "edit";

export type PreviewClaims = { slug: string; mode: PreviewMode; exp: number };

const SLUG = /^[a-z0-9-]+$/;

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

const sign = (key: Buffer, payload: string) =>
	createHmac("sha256", key).update(payload).digest();

export function mintToken(key: Buffer, claims: PreviewClaims): string {
	const payload = b64(JSON.stringify(claims));
	return `${payload}.${b64(sign(key, payload))}`;
}

function claimsOf(payload: string): PreviewClaims | null {
	try {
		const parsed = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		if (
			typeof parsed?.slug === "string" &&
			SLUG.test(parsed.slug) &&
			(parsed.mode === "view" || parsed.mode === "edit") &&
			typeof parsed.exp === "number"
		)
			return { slug: parsed.slug, mode: parsed.mode, exp: parsed.exp };
	} catch {
		return null;
	}
	return null;
}

export function verifyToken(
	key: Buffer,
	token: string,
	nowMs: number,
): PreviewClaims | null {
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [payload, mac] = parts as [string, string];
	const given = Buffer.from(mac, "base64url");
	const expected = sign(key, payload);
	if (given.length !== expected.length || !timingSafeEqual(given, expected))
		return null;
	const claims = claimsOf(payload);
	return claims && claims.exp > nowMs ? claims : null;
}
