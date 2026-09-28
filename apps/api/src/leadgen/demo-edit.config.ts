import { LEAD_VIEWS } from "./lead-views.config";

export const LG_DEMO_DIRS = Symbol("LG_DEMO_DIRS");
export const LG_PREVIEW_KEY = Symbol("LG_PREVIEW_KEY");
export const LG_DEMO_CLOCK = Symbol("LG_DEMO_CLOCK");

export type DemoClock = () => Date;

export type DemoDirs = { outputDir: string; backupDir: string };

export const defaultDemoDirs = (
	env: Record<string, string | undefined>,
): DemoDirs => ({
	outputDir: LEAD_VIEWS.files.siteOutput,
	backupDir: env.LEADGEN_DEMO_BACKUP_DIR ?? "/data/leadgen/demo-edit-backups",
});

export const PREVIEW = {
	ttlMs: 15 * 60_000,
	routePrefix: "/api/leadgen/demo-preview",
} as const;

export const DEPLOY_HINT = (slug: string) =>
	`cd /data/leadgen/site-generator && bash deploy-demo.sh ${slug}`;
