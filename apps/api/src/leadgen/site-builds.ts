import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LEAD_VIEWS } from "./lead-views.config";
import type { BuildKind } from "./lead-views.rows";

const DIR_CACHE_MS = 60_000;

export function resolveBuildDir(
	slug: string,
	dirs: readonly string[],
): string | null {
	if (!/^[a-z0-9-]+$/.test(slug)) return null;
	if (dirs.includes(slug)) return slug;
	const prefixed = dirs.filter((d) => d.startsWith(slug));
	return prefixed.length === 1 ? (prefixed[0] ?? null) : null;
}

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

export class SiteBuilds {
	private dirs: string[] = [];
	private loadedAt = 0;

	private async listDirs(): Promise<string[]> {
		if (Date.now() - this.loadedAt < DIR_CACHE_MS) return this.dirs;
		this.dirs = await readdir(LEAD_VIEWS.files.siteOutput).catch(() => []);
		this.loadedAt = Date.now();
		return this.dirs;
	}

	async kindOf(slug: string | null): Promise<BuildKind> {
		if (!slug) return "unknown";
		const dir = resolveBuildDir(slug, await this.listDirs());
		if (!dir) return "unknown";
		const base = join(LEAD_VIEWS.files.siteOutput, dir);
		if (await exists(join(base, "assets"))) return "v2";
		return (await exists(join(base, "index.html"))) ? "v1" : "unknown";
	}
}
