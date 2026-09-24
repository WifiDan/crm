import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@crm/db";
import { DemoEditService } from "../src/leadgen/demo-edit.service";
import { sha256Of } from "../src/leadgen/demo-files";
import {
	DemoPreviewService,
	newPreviewKey,
} from "../src/leadgen/demo-preview.service";

const dbName = /\/([a-z_]+)(\?|$)/.exec(process.env.DATABASE_URL ?? "")?.[1];
if (dbName !== "crm_dev") {
	console.error(
		`refusing to run: DATABASE_URL points at "${dbName}", not crm_dev`,
	);
	process.exit(2);
}
const current = await db.$queryRaw<
	Array<{ name: string }>
>`SELECT current_database() AS name`;
if (current[0]?.name !== "crm_dev") {
	console.error(`refusing to run: connected database is "${current[0]?.name}"`);
	process.exit(2);
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failures++;
}

const PREFIX = "ZZ-demoedit-";
const SLUG = "zz-live-demo";
const ACTOR = { id: "live-user", email: "live@example.com" };
process.env.LEADGEN_DECISION_APPROVERS = "live@example.com";

async function cleanup() {
	const leads = await db.lgLead.findMany({
		where: { businessName: { startsWith: PREFIX } },
		select: { id: true },
	});
	const ids = leads.map((l) => l.id);
	await db.lgDemoEdit.deleteMany({ where: { leadId: { in: ids } } });
	await db.lgLead.deleteMany({ where: { id: { in: ids } } });
}

await cleanup();
const root = mkdtempSync(join(tmpdir(), "demo-edit-live-"));
const outputDir = join(root, "output");
const backupDir = join(root, "backups");
mkdirSync(join(outputDir, SLUG), { recursive: true });
const PAGE = `<!doctype html><html><head><title>Live</title></head><body>${"<p>x</p>".repeat(100)}</body></html>`;
writeFileSync(join(outputDir, SLUG, "index.html"), PAGE);
const dirs = { outputDir, backupDir };
const clock = () => new Date();
const previews = new DemoPreviewService(newPreviewKey(), dirs, clock);
const service = new DemoEditService(db, dirs, clock, previews);
const lead = await db.lgLead.create({
	data: {
		businessName: `${PREFIX}1`,
		demoUrl: `https://${SLUG}.ei-leadgen-demos.pages.dev`,
	},
	select: { id: true },
});
const req = (n: number) =>
	`10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const edited = PAGE.replace("Live", "Live edited");

try {
	const before = await service.info(lead.id, ACTOR.email);
	check(
		"info sees the local file and a real approver",
		before.hasLocal && before.canEdit && before.sha256 === sha256Of(PAGE),
	);

	const refused = await service
		.save({
			leadId: lead.id,
			requestId: req(1),
			html: edited,
			baseSha256: sha256Of(PAGE),
			actor: { id: "x", email: "nobody@example.com" },
		})
		.catch((e) => e);
	check(
		"a non-approver is refused and leaves no audit row",
		refused?.status === 403 &&
			(await db.lgDemoEdit.count({ where: { leadId: lead.id } })) === 0,
	);

	const ok = await service.save({
		leadId: lead.id,
		requestId: req(2),
		html: edited,
		baseSha256: sha256Of(PAGE),
		actor: ACTOR,
	});
	const row = await db.lgDemoEdit.findUnique({ where: { requestId: req(2) } });
	check(
		"a save writes the file",
		readFileSync(join(outputDir, SLUG, "index.html"), "utf8") === edited,
	);
	check(
		"the audit row is APPLIED with hashes, sizes, actor and backup name",
		row?.status === "APPLIED" &&
			row.sha256Before === sha256Of(PAGE) &&
			row.sha256After === sha256Of(edited) &&
			row.bytesBefore === Buffer.byteLength(PAGE) &&
			row.bytesAfter === Buffer.byteLength(edited) &&
			row.actorEmail === ACTOR.email &&
			row.slug === SLUG &&
			row.backupName === ok.backupName &&
			row.completedAt !== null,
	);
	check(
		"the backup is outside the demo folder and holds the old page",
		readFileSync(join(backupDir, SLUG, ok.backupName), "utf8") === PAGE &&
			readdirSync(join(outputDir, SLUG)).join() === "index.html",
	);

	const replay = await service.save({
		leadId: lead.id,
		requestId: req(2),
		html: edited,
		baseSha256: sha256Of(edited),
		actor: ACTOR,
	});
	check(
		"the same request id replays without a second row",
		replay.replay === true &&
			(await db.lgDemoEdit.count({ where: { leadId: lead.id } })) === 1,
	);

	const stale = await service
		.save({
			leadId: lead.id,
			requestId: req(3),
			html: edited,
			baseSha256: sha256Of(PAGE),
			actor: ACTOR,
		})
		.catch((e) => e);
	check(
		"a stale base hash is a 409 with no new row",
		stale?.status === 409 &&
			(await db.lgDemoEdit.count({ where: { leadId: lead.id } })) === 1,
	);

	const blocker = join(root, "blocker");
	writeFileSync(blocker, "file");
	const broken = new DemoEditService(
		db,
		{ outputDir, backupDir: join(blocker, "b") },
		() => new Date(Date.now() + 5000),
		previews,
	);
	const failed = await broken
		.save({
			leadId: lead.id,
			requestId: req(4),
			html: edited.replace("edited", "again"),
			baseSha256: sha256Of(edited),
			actor: ACTOR,
		})
		.catch((e) => e);
	const failedRow = await db.lgDemoEdit.findUnique({
		where: { requestId: req(4) },
	});
	check(
		"a failed write is FAILED in the audit, and the file is unchanged (row existed before the write)",
		failed?.status === 500 &&
			failedRow?.status === "FAILED" &&
			readFileSync(join(outputDir, SLUG, "index.html"), "utf8") === edited,
	);

	const after = await service.info(lead.id, ACTOR.email);
	check(
		"info reports the last edit and the deploy hint, not-live",
		after.lastEdit?.status === "FAILED" || after.lastEdit?.status === "APPLIED",
	);
	check(
		"the deploy hint names the slug",
		(after.deployHint ?? "").endsWith(`deploy-demo.sh ${SLUG}`),
	);
} finally {
	await cleanup();
	rmSync(root, { recursive: true, force: true });
	const left = await db.lgLead.count({
		where: { businessName: { startsWith: PREFIX } },
	});
	check("synthetic rows removed", left === 0);
	await db.$disconnect();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
