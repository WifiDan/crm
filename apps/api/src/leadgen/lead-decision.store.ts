import type { LeadPatch, LiveRow } from "./lead-decision.rules";

export const LG_LEAD_STORE = Symbol("LG_LEAD_STORE");

export const NOCODB_TIMEOUT_MS = 15_000;

export type ColumnState = "present" | "absent" | "unknown";

export type WriteConfig =
	| { ok: true; source: "dedicated" | "shared-with-mirror" }
	| { ok: false; reason: string };

export class NocoWriteError extends Error {
	constructor(
		readonly kind: "rejected" | "unknown",
		readonly status: number | null,
		message: string,
	) {
		super(message);
		this.name = "NocoWriteError";
	}
}

export interface LeadRowStore {
	writeConfig(): WriteConfig;
	getRow(tableId: string, rowId: number): Promise<LiveRow | null>;
	columnState(tableId: string, title: string): Promise<ColumnState>;
	patchRow(tableId: string, patch: LeadPatch): Promise<void>;
}

type Env = Record<string, string | undefined>;
export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const DEFINITE_CODES = new Set([
	"ECONNREFUSED",
	"ConnectionRefused",
	"ENOTFOUND",
	"EAI_AGAIN",
]);

function resolveConfig(env: Env) {
	const base = (env.NOCODB_URL ?? "").trim().replace(/\/+$/, "");
	const dedicated = (env.NOCODB_LEADS_WRITE_TOKEN ?? "").trim();
	const shared = (env.NOCODB_LEADS_TOKEN ?? "").trim();
	const token = dedicated || shared;
	const source = dedicated ? "dedicated" : "shared-with-mirror";
	return { base, token, source } as const;
}

export function nocodbLeadStore(
	env: Env,
	fetchImpl: FetchLike = fetch,
	timeoutMs: number = NOCODB_TIMEOUT_MS,
): LeadRowStore {
	const settings = () => {
		const cfg = resolveConfig(env);
		if (!/^https?:\/\/[^\s/]+/.test(cfg.base))
			throw new Error("NOCODB_URL is not set");
		if (!cfg.token) throw new Error("no NocoDB token is set");
		return cfg;
	};
	const headers = (token: string) => ({
		"xc-token": token,
		"Content-Type": "application/json",
	});

	return {
		writeConfig() {
			const cfg = resolveConfig(env);
			if (!/^https?:\/\/[^\s/]+/.test(cfg.base))
				return { ok: false, reason: "NOCODB_URL is not set" };
			if (!cfg.token)
				return {
					ok: false,
					reason:
						"neither NOCODB_LEADS_WRITE_TOKEN nor NOCODB_LEADS_TOKEN is set",
				};
			return { ok: true, source: cfg.source };
		},

		async getRow(tableId, rowId) {
			const { base, token } = settings();
			const res = await fetchImpl(
				`${base}/api/v2/tables/${encodeURIComponent(tableId)}/records/${rowId}`,
				{
					headers: headers(token),
					signal: AbortSignal.timeout(timeoutMs),
				},
			);
			if (res.status === 404) return null;
			if (!res.ok)
				throw new Error(`NocoDB read failed with status ${res.status}`);
			const body: unknown = await res.json();
			if (typeof body !== "object" || body === null || Array.isArray(body))
				throw new Error("NocoDB read returned an unexpected body");
			return body as LiveRow;
		},

		async columnState(tableId, title) {
			try {
				const { base, token } = settings();
				const res = await fetchImpl(
					`${base}/api/v2/meta/tables/${encodeURIComponent(tableId)}`,
					{
						headers: headers(token),
						signal: AbortSignal.timeout(timeoutMs),
					},
				);
				if (!res.ok) return "unknown";
				const meta = (await res.json()) as {
					columns?: Array<{ title?: unknown }>;
				};
				if (!Array.isArray(meta.columns)) return "unknown";
				return meta.columns.some((c) => c.title === title)
					? "present"
					: "absent";
			} catch {
				return "unknown";
			}
		},

		async patchRow(tableId, patch) {
			const { base, token } = settings();
			let res: Response;
			try {
				res = await fetchImpl(
					`${base}/api/v2/tables/${encodeURIComponent(tableId)}/records`,
					{
						method: "PATCH",
						headers: headers(token),
						body: JSON.stringify(patch),
						signal: AbortSignal.timeout(timeoutMs),
					},
				);
			} catch (e) {
				const code = (e as { code?: string }).code ?? "";
				throw new NocoWriteError(
					DEFINITE_CODES.has(code) ? "rejected" : "unknown",
					null,
					`NocoDB did not answer (${code || (e as Error).name})`,
				);
			}
			if (res.ok) return;
			const definite =
				res.status >= 400 && res.status < 500 && res.status !== 408;
			const kind = definite ? "rejected" : "unknown";
			throw new NocoWriteError(
				kind,
				res.status,
				`NocoDB answered ${res.status}`,
			);
		},
	};
}
