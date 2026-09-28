import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { db, EnrichmentStatus } from "@crm/db";
import { writeContextDevKey } from "@crm/db/settings";
import { inEveContext, researchCtx } from "./eve-context";

/**
 * The failure this covers, reproduced from the pilot's own Granite run:
 * `research_company` could not load `mocajoesdelta.com` (HTTP 000), and the
 * model then wrote a fabricated city, a fabricated state and a fabricated
 * LinkedIn URL. The vendor SDK is stubbed here so both outcomes — a dead site
 * and a live one — can be driven without a model, a network call or a credit.
 */

const RealContextDev = (await import("context.dev")).default;

type Extracted = { data: unknown };

let extractOutcome: () => Promise<Extracted> = async () => ({ data: {} });

const extractCalls: string[] = [];

class StubbedContextDev {
	web = {
		extract: async (params: { url: string }): Promise<Extracted> => {
			extractCalls.push(params.url);
			return extractOutcome();
		},
		search: async () => ({ results: [] }),
	};
	brand = {
		retrieve: async () => {
			throw new Error("brand.retrieve is not stubbed for this test");
		},
	};
	people = {
		enrich: async () => {
			throw new Error("people.enrich is not stubbed for this test");
		},
	};
	utility = { prefetch: async () => {} };
}

mock.module("context.dev", () => ({ default: StubbedContextDev }));

const FABRICATED = "https://www.linkedin.com/company/zz-guard-test";

type ToolResult = {
	written?: boolean;
	reason?: string;
	sourceUnavailable?: boolean;
	taskClosed?: boolean;
};

type Tool<Input> = {
	execute: (input: Input, ctx: never) => Promise<ToolResult>;
};

let researchCompany: Tool<{ companyId: string }>;
let setFieldValue: Tool<{
	entity: "COMPANY" | "CONTACT" | "DEAL";
	recordId: string;
	key: string;
	value: string | number | boolean | null;
	sourceUrl: string;
}>;
type BriefInput = {
	contactId: string;
	narrative: string;
	sections: { currentRole: string };
	evidence: { kind: string; detail: string; sourceUrl: string }[];
	sourceUrl: string;
};

let writeBriefTool: Tool<BriefInput>;
let focusOn: (input: {
	companyId: string;
	sessionId: string;
	taskKind: string;
}) => void;

const created = {
	companyIds: [] as string[],
	contactIds: [] as string[],
	taskIds: [] as string[],
	fieldIds: [] as string[],
	userIds: [] as string[],
};

const FIELD_KEY = "zzGuardTestNote";

beforeAll(async () => {
	researchCompany = (await import("../agent/tools/research_company")).default;
	setFieldValue = (await import("../agent/tools/set_field_value")).default;
	writeBriefTool = (await import("../agent/tools/write_brief")).default;
	focusOn = (await import("../agent/lib/focus")).focusOn;

	// The throwaway test database has no vendor key, and the SDK above is
	// stubbed, so this is a placeholder that never leaves the process.
	await writeContextDevKey(db, "zz-guard-test-not-a-real-key");

	const owner = await db.user.create({
		data: {
			id: `zz-guard-${crypto.randomUUID()}`,
			name: "ZZ Guard Owner",
			email: `zz-guard-owner-${crypto.randomUUID()}@example.test`,
		},
		select: { id: true },
	});

	created.userIds.push(owner.id);

	const last = await db.fieldDefinition.findFirst({
		where: { entity: "COMPANY" },
		orderBy: { position: "desc" },
		select: { position: true },
	});

	const field = await db.fieldDefinition.create({
		data: {
			entity: "COMPANY",
			key: FIELD_KEY,
			label: "ZZ guard test note",
			type: "TEXT",
			agentFilled: true,
			position: (last?.position ?? -1) + 1,
		},
		select: { id: true },
	});

	created.fieldIds.push(field.id);
});

afterAll(async () => {
	// Only rows this spec created, by id.
	if (created.taskIds.length > 0) {
		await db.agentTask.deleteMany({ where: { id: { in: created.taskIds } } });
	}
	if (created.companyIds.length > 0) {
		await db.activity.deleteMany({
			where: { companyId: { in: created.companyIds } },
		});
		await db.fieldValue.deleteMany({
			where: { companyId: { in: created.companyIds } },
		});
		await db.company.deleteMany({ where: { id: { in: created.companyIds } } });
	}
	if (created.contactIds.length > 0) {
		await db.contactFact.deleteMany({
			where: { contactId: { in: created.contactIds } },
		});
		await db.contact.deleteMany({ where: { id: { in: created.contactIds } } });
	}
	if (created.userIds.length > 0) {
		await db.user.deleteMany({ where: { id: { in: created.userIds } } });
	}
	if (created.fieldIds.length > 0) {
		await db.fieldValue.deleteMany({
			where: { fieldId: { in: created.fieldIds } },
		});
		await db.fieldDefinition.deleteMany({
			where: { id: { in: created.fieldIds } },
		});
	}

	mock.module("context.dev", () => ({ default: RealContextDev }));
});

async function subject() {
	const host = `zz-guard-${crypto.randomUUID().slice(0, 8)}.example.com`;
	const site = `https://${host}`;

	const company = await db.company.create({
		data: {
			name: `ZZ Guard Test ${crypto.randomUUID().slice(0, 8)}`,
			website: site,
			domain: host,
			enrichmentStatus: EnrichmentStatus.RUNNING,
			ownerId: created.userIds[0],
		},
		select: { id: true },
	});

	created.companyIds.push(company.id);

	const sessionId = `test-session-${crypto.randomUUID()}`;

	const task = await db.agentTask.create({
		data: {
			kind: "company-profile",
			reason: "guard test",
			dueAt: new Date(Date.now() - 1000),
			budget: 4,
			companyId: company.id,
			startedAt: new Date(),
			attempts: 1,
			sessionId,
		},
		select: { id: true },
	});

	created.taskIds.push(task.id);

	return { companyId: company.id, taskId: task.id, sessionId, site };
}

describe("a company whose site cannot be read", () => {
	it("fails the task cleanly and refuses every write after it", async () => {
		const { companyId, taskId, sessionId, site } = await subject();

		extractOutcome = async () => {
			throw new Error("fetch failed: connect ECONNREFUSED (HTTP 000)");
		};

		const refusals: ToolResult[] = [];

		const research = await inEveContext(async () => {
			focusOn({ companyId, sessionId, taskKind: "company-profile" });

			const outcome = await researchCompany.execute({ companyId }, researchCtx);

			// Everything the model might try next, in the same session.
			refusals.push(
				await setFieldValue.execute(
					{
						entity: "COMPANY",
						recordId: companyId,
						key: FIELD_KEY,
						value: "Delta, California",
						sourceUrl: FABRICATED,
					},
					researchCtx,
				),
				await setFieldValue.execute(
					{
						entity: "COMPANY",
						recordId: companyId,
						key: FIELD_KEY,
						value: "Delta, California",
						sourceUrl: site,
					},
					researchCtx,
				),
			);

			return outcome;
		});

		expect(research.written).toBe(false);
		expect(research.sourceUnavailable).toBe(true);
		expect(research.taskClosed).toBe(true);

		const task = await db.agentTask.findUnique({ where: { id: taskId } });
		expect(task?.finishedAt).not.toBeNull();
		expect(task?.outcome).toStartWith("Source unavailable");

		// Upstream lets only the `brand` lane own a company's enrichment status
		// (COMPANY_STATUS_KINDS), so a company-profile task settles nothing here.
		// The task's own outcome is the record of the failure.
		const company = await db.company.findUnique({ where: { id: companyId } });
		expect(company?.enrichmentStatus).toBe(EnrichmentStatus.RUNNING);

		// Nothing was written: no brief on the timeline, no field value.
		expect(await db.activity.count({ where: { companyId } })).toBe(0);
		expect(await db.fieldValue.count({ where: { companyId } })).toBe(0);

		for (const refusal of refusals) {
			expect(refusal.written).toBe(false);
			expect(String(refusal.reason)).toContain("Source unavailable");
		}
	});

	it("treats a page that returns nothing as no source at all", async () => {
		const { companyId, taskId, sessionId } = await subject();

		extractOutcome = async () => ({
			data: { positioning: null, notableCustomers: [] },
		});

		const research = await inEveContext(async () => {
			focusOn({ companyId, sessionId, taskKind: "company-profile" });
			return researchCompany.execute({ companyId }, researchCtx);
		});

		expect(research.written).toBe(false);
		expect(research.taskClosed).toBe(true);

		const task = await db.agentTask.findUnique({ where: { id: taskId } });
		expect(task?.outcome).toContain("nothing usable");
		expect(await db.activity.count({ where: { companyId } })).toBe(0);
	});
});

describe("a company whose site reads normally", () => {
	it("still writes the brief, the field and the contact background", async () => {
		const { companyId, taskId, sessionId, site } = await subject();

		extractOutcome = async () => ({
			data: {
				positioning:
					"A regional coffeehouse and food service business serving Delta, Colorado.",
				pricingModel: "Per item, in store.",
				targetCustomer: "Local walk-in customers.",
				notableCustomers: [],
				recentNews: [],
			},
		});

		const contact = await db.contact.create({
			data: {
				firstName: "ZZ",
				lastName: "Guard",
				email: `zz-guard-${crypto.randomUUID()}@example.test`,
				companyId,
			},
			select: { id: true },
		});

		created.contactIds.push(contact.id);

		const out = await inEveContext(async () => {
			focusOn({ companyId, sessionId, taskKind: "company-profile" });

			const research = await researchCompany.execute(
				{ companyId },
				researchCtx,
			);

			const written = await setFieldValue.execute(
				{
					entity: "COMPANY",
					recordId: companyId,
					key: FIELD_KEY,
					value: "Delta, Colorado",
					sourceUrl: `${site}/about`,
				},
				researchCtx,
			);

			const invented = await setFieldValue.execute(
				{
					entity: "COMPANY",
					recordId: companyId,
					key: FIELD_KEY,
					value: "Delta, California",
					sourceUrl: FABRICATED,
				},
				researchCtx,
			);

			const brief = await writeBriefTool.execute(
				{
					contactId: contact.id,
					narrative:
						"ZZ Guard runs the counter at the coffeehouse in Delta, Colorado, and has done since it opened.",
					sections: { currentRole: "Manager · ZZ Guard Test" },
					evidence: [
						{
							kind: "web.cited-claim",
							detail: "the site names them",
							sourceUrl: `${site}/team`,
						},
					],
					sourceUrl: `${site}/team`,
				},
				researchCtx,
			);

			const inventedBrief = await writeBriefTool.execute(
				{
					contactId: contact.id,
					narrative:
						"ZZ Guard runs the counter at the coffeehouse in Delta, California, and has done since it opened.",
					sections: { currentRole: "Manager · ZZ Guard Test" },
					evidence: [
						{
							kind: "linkedin.employer-and-name",
							detail: "their LinkedIn says so",
							sourceUrl: FABRICATED,
						},
					],
					sourceUrl: FABRICATED,
				},
				researchCtx,
			);

			return { research, written, invented, brief, inventedBrief };
		});

		expect(out.research.written).toBe(true);

		// The task is left open for the session to finish normally.
		const task = await db.agentTask.findUnique({ where: { id: taskId } });
		expect(task?.finishedAt).toBeNull();

		// The research brief really landed on the timeline.
		expect(await db.activity.count({ where: { companyId } })).toBe(1);

		// The field write went through, citing the page that was fetched.
		expect(out.written.written).toBe(true);

		const value = await db.fieldValue.findFirst({
			where: { companyId, fieldId: created.fieldIds[0] },
			select: { text: true },
		});

		expect(value?.text).toBe("Delta, Colorado");

		// The fabricated citation was refused in the same, otherwise healthy run.
		expect(out.invented.written).toBe(false);
		expect(String(out.invented.reason)).toContain("linkedin.com");

		expect(out.brief.written).toBe(true);
		expect(out.inventedBrief.written).toBe(false);
		expect(String(out.inventedBrief.reason)).toContain("linkedin.com");

		// The value on the record is still the true one.
		const after = await db.fieldValue.findFirst({
			where: { companyId, fieldId: created.fieldIds[0] },
			select: { text: true },
		});

		expect(after?.text).toBe("Delta, Colorado");
		expect(extractCalls.length).toBeGreaterThan(0);
	});
});
