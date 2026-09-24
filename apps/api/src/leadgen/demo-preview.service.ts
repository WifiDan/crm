import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Inject, Injectable } from "@nestjs/common";
import { injectBridge } from "./demo-bridge";
import {
	type DemoClock,
	type DemoDirs,
	LG_DEMO_CLOCK,
	LG_DEMO_DIRS,
	LG_PREVIEW_KEY,
	PREVIEW,
} from "./demo-edit.config";
import {
	DemoFileError,
	isHtmlType,
	resolveDemoDir,
	resolveDemoFile,
} from "./demo-files";
import { mintToken, type PreviewMode, verifyToken } from "./demo-preview-token";

export const newPreviewKey = () => randomBytes(32);

export type Served = {
	status: number;
	headers: Record<string, string>;
	body: Buffer | string;
};

export function previewHeaders(type: string): Record<string, string> {
	return {
		"Content-Type": type,
		"Content-Security-Policy":
			"sandbox allow-scripts; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "private, no-store",
		"Cross-Origin-Resource-Policy": "cross-origin",
		"Access-Control-Allow-Origin": "*",
	};
}

const notFound = (): Served => ({
	status: 404,
	headers: previewHeaders("text/plain; charset=utf-8"),
	body: "not found",
});

@Injectable()
export class DemoPreviewService {
	constructor(
		@Inject(LG_PREVIEW_KEY) private readonly key: Buffer,
		@Inject(LG_DEMO_DIRS) private readonly dirs: DemoDirs,
		@Inject(LG_DEMO_CLOCK) private readonly clock: DemoClock,
	) {}

	mint(slug: string, mode: PreviewMode) {
		const exp = this.clock().getTime() + PREVIEW.ttlMs;
		const token = mintToken(this.key, { slug, mode, exp });
		return {
			path: `${PREVIEW.routePrefix}/${token}/${slug}/index.html`,
			expiresAt: new Date(exp).toISOString(),
			mode,
		};
	}

	async serve(suffix: string): Promise<Served> {
		const parts = suffix.split("/");
		const [token, slug, ...rest] = parts;
		if (!token || !slug) return notFound();
		const claims = verifyToken(this.key, token, this.clock().getTime());
		if (!claims || claims.slug !== slug) return notFound();
		const segments = decodeAll(rest);
		if (!segments) return notFound();
		try {
			const dir = await resolveDemoDir(this.dirs.outputDir, claims.slug);
			const file = await resolveDemoFile(dir, segments);
			const raw = await readFile(file.path);
			if (claims.mode === "edit" && isHtmlType(file.type)) {
				return {
					status: 200,
					headers: previewHeaders(file.type),
					body: injectBridge(raw.toString("utf8")),
				};
			}
			return { status: 200, headers: previewHeaders(file.type), body: raw };
		} catch (e) {
			if (e instanceof DemoFileError) return notFound();
			throw e;
		}
	}
}

function decodeAll(rest: string[]): string[] | null {
	const trimmed = rest.at(-1) === "" ? rest.slice(0, -1) : rest;
	try {
		return trimmed.map((s) => decodeURIComponent(s));
	} catch {
		return null;
	}
}
