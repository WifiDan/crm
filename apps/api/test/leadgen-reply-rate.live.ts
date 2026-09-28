import { db } from "@crm/db";
import { MIRROR_TABLES } from "../src/leadgen/mirror-map";
import { LeadgenOpsService } from "../src/leadgen/ops.service";

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

const ISP = MIRROR_TABLES.find((t) => t.key === "isp")?.tableId ?? "";
const PREFIX = "ZZ-rate-";
const ROW_BASE = 9_100_000;
const ops = new LeadgenOpsService(db);

async function cleanup() {
	const ids = (
		await db.lgLead.findMany({
			where: { businessName: { startsWith: PREFIX } },
			select: { id: true },
		})
	).map((l) => l.id);
	await db.lgInboundMessage.deleteMany({
		where: { messageId: { startsWith: "zz-rate-" } },
	});
	await db.lgLead.deleteMany({ where: { id: { in: ids } } });
}

try {
	await cleanup();
	const before = (await ops.overview()).totals;
	const sentAt = new Date(Date.UTC(2026, 8, 1, 14, 0));
	await db.lgLead.createMany({
		data: [0, 1, 2, 3, 4].map((i) => ({
			businessName: `${PREFIX}${i}`,
			nocodbTable: ISP,
			nocodbRowId: ROW_BASE + i,
			raw: { Id: ROW_BASE + i },
			sentAt: i < 4 ? sentAt : null,
			repliedAt: i < 2 ? new Date(Date.UTC(2026, 8, 2, 9, 0)) : null,
			mirroredAt: new Date(),
		})),
	});
	const repliers = await db.lgLead.findMany({
		where: { businessName: { in: [`${PREFIX}0`, `${PREFIX}1`] } },
		select: { id: true, businessName: true },
	});
	const first = repliers.find((l) => l.businessName === `${PREFIX}0`);
	const second = repliers.find((l) => l.businessName === `${PREFIX}1`);
	await db.lgInboundMessage.createMany({
		data: [
			...[1, 2, 3].map((n) => ({
				messageId: `zz-rate-a${n}`,
				fromAddr: "a@example.com",
				matchedLeadId: first?.id,
			})),
			{
				messageId: "zz-rate-b1",
				fromAddr: "b@example.com",
				matchedLeadId: second?.id,
			},
		],
	});
	const after = (await ops.overview()).totals;
	check(
		"two replied leads with four inbound messages add 2 to replied",
		after.replied - before.replied === 2,
		`${after.replied - before.replied}`,
	);
	check(
		"four leads with an initial send add 4 to sent",
		after.sent - before.sent === 4,
		`${after.sent - before.sent}`,
	);
	const msgs = await db.lgInboundMessage.count({
		where: { messageId: { startsWith: "zz-rate-" } },
	});
	check("the fixture really holds 4 inbound messages", msgs === 4, `${msgs}`);
} finally {
	await cleanup();
	const left = await db.lgLead.count({
		where: { businessName: { startsWith: PREFIX } },
	});
	check("fixture rows removed", left === 0, `${left}`);
	await db.$disconnect();
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
