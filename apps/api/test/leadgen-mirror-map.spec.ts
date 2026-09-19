import { describe, expect, test } from "bun:test";
import {
	deriveStage,
	hashRow,
	MIRROR_TABLES,
	nocoRowSchema,
	stableStringify,
	toLeadFields,
} from "../src/leadgen/mirror-map";

const isp = MIRROR_TABLES[0];
const gym = MIRROR_TABLES[1];
if (!isp || !gym) throw new Error("mirror tables missing");

function row(fields: Record<string, string | number | boolean | null>) {
	return nocoRowSchema.parse({ Id: 1, ...fields });
}

describe("stage derivation", () => {
	test("Do Not Contact always wins", () => {
		expect(
			deriveStage(
				row({ "Do Not Contact": true, "Sent At": "2026-09-01T00:00:00Z" }),
				isp,
			),
		).toBe("DEAD");
	});

	test("reply beats sent", () => {
		expect(
			deriveStage(
				row({
					"Replied At": "2026-09-03T00:00:00Z",
					"Sent At": "2026-09-01T00:00:00Z",
				}),
				isp,
			),
		).toBe("REPLIED");
	});

	test("approved with a demo is BUILT, without is APPROVED", () => {
		expect(
			deriveStage(
				row({ "Approval Decision": "Approved", "Demo Site URL": "https://x" }),
				isp,
			),
		).toBe("BUILT");
		expect(deriveStage(row({ "Approval Decision": "Approved" }), isp)).toBe(
			"APPROVED",
		);
	});

	test("send-approved is READY; rejected is REJECTED; blank is NEW", () => {
		expect(
			deriveStage(
				row({ "Approval Decision": "Approved", "Send Approved": true }),
				isp,
			),
		).toBe("READY");
		expect(deriveStage(row({ "Approval Decision": "Rejected" }), isp)).toBe(
			"REJECTED",
		);
		expect(deriveStage(row({}), isp)).toBe("NEW");
	});

	test("gym table reads its own demo column", () => {
		expect(
			deriveStage(
				row({
					"Approval Decision": "Approved",
					"Demo/New Site URL": "https://g",
				}),
				gym,
			),
		).toBe("BUILT");
	});
});

describe("hashing", () => {
	test("key order does not change the hash", () => {
		expect(hashRow({ a: 1, b: { c: 2, d: 3 } })).toBe(
			hashRow({ b: { d: 3, c: 2 }, a: 1 }),
		);
	});

	test("a changed value changes the hash", () => {
		expect(hashRow({ a: 1 })).not.toBe(hashRow({ a: 2 }));
	});

	test("stableStringify sorts nested keys", () => {
		expect(stableStringify({ z: [1, { y: 1, x: 2 }], a: null })).toBe(
			'{"a":null,"z":[1,{"x":2,"y":1}]}',
		);
	});
});

describe("field mapping", () => {
	test("maps ISP columns and falls back from Email to Contact Email", () => {
		const f = toLeadFields(
			row({
				"Business Name": "  Acme  ",
				Address: "1 Main",
				"Contact Email": "a@b.co",
				"Quality Score": "7",
				"Has Website": true,
			}),
			isp,
		);
		expect(f.businessName).toBe("Acme");
		expect(f.email).toBe("a@b.co");
		expect(f.qualityScore).toBe(7);
		expect(f.hasWebsite).toBe(true);
	});

	test("maps gym columns", () => {
		const f = toLeadFields(
			row({ "Gym Name": "Iron", "Address / Location": "Denver" }),
			gym,
		);
		expect(f.businessName).toBe("Iron");
		expect(f.address).toBe("Denver");
	});

	test("a nameless row does not crash the mirror", () => {
		expect(toLeadFields(row({}), isp).businessName).toBe("(unnamed)");
	});

	test("a row missing its Id fails the contract loudly", () => {
		expect(nocoRowSchema.safeParse({ "Business Name": "x" }).success).toBe(
			false,
		);
	});
});
