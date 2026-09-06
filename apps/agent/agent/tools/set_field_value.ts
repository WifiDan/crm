import { defineTool } from "eve/tools";
import { z } from "zod";
import { writeField } from "../lib/fields";
import { focusOn } from "../lib/focus";
import { verifySource, writesBlocked } from "../lib/sources";

export default defineTool({
	description:
		"Set one custom field on one record, when you have read the answer from a source rather than guessed it. Pass sourceUrl: the page you read it on, which must be one this session actually fetched — a citation that was not fetched is refused, not warned about. The field's brief says what would count — follow it. Call list_fields first if you do not know the key. A field the rep marked manual will refuse.",
	inputSchema: z.object({
		entity: z.enum(["COMPANY", "CONTACT", "DEAL"]),
		recordId: z.string().describe("The id of the company, contact or deal."),
		key: z
			.string()
			.describe("The field's key, exactly as list_fields reports it."),
		value: z
			.union([z.string(), z.number(), z.boolean(), z.null()])
			.describe(
				"The value. A select takes the option's label, a date takes YYYY-MM-DD, and null clears it.",
			),
		sourceUrl: z
			.string()
			.describe(
				"The page you read this value on. It must be a page fetched in this session — leave the field blank rather than cite one you have not opened.",
			),
	}),
	async execute({ entity, recordId, key, value, sourceUrl }) {
		if (entity === "COMPANY") focusOn({ companyId: recordId });
		if (entity === "CONTACT") focusOn({ contactId: recordId });

		// Clearing a field asserts nothing, so it needs no source of its own —
		// but a session whose source failed writes nothing at all.
		if (value !== null || writesBlocked()) {
			const verdict = verifySource(sourceUrl);

			if (!verdict.ok) {
				return { written: false as const, reason: verdict.reason };
			}
		}

		return writeField({ entity, recordId, key, value });
	},
});
