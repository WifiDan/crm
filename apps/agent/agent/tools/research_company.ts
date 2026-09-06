import { ActivityType, db } from "@crm/db";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { extract, type JsonSchema } from "../lib/context-dev";
import { spend } from "../lib/focus";
import { failForMissingSource } from "../lib/sources";

const RESEARCH_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		positioning: {
			type: "string",
			description: "One paragraph: what they sell and who to.",
		},
		pricingModel: {
			type: "string",
			description: "How they charge — per seat, usage, flat, enterprise-only.",
		},
		targetCustomer: {
			type: "string",
			description: "The customer they describe themselves as serving.",
		},
		notableCustomers: {
			type: "array",
			items: { type: "string" },
			description: "Named customers or logos on the site.",
		},
		recentNews: {
			type: "array",
			items: { type: "string" },
			description: "Recent announcements, funding, or launches.",
		},
	},
	required: ["positioning"],
};

const RESEARCH_INSTRUCTIONS =
	"Read this company's marketing site and answer as a salesperson preparing " +
	"for a first call. Be specific and factual; leave a field empty rather than " +
	"guessing.";

const briefText = z.string().trim().min(1).nullable().catch(null);

const briefList = z
	.array(z.string().nullable().catch(null))
	.transform((items) => items.filter((item) => item !== null))
	.catch([]);

const briefScalar = z
	.union([z.string(), z.number(), z.boolean()])
	.nullable()
	.catch(null);

const researchBrief = z
	.object({
		positioning: briefText,
		pricingModel: briefText,
		targetCustomer: briefText,
		notableCustomers: briefList,
		recentNews: briefList,
	})
	.catch({
		positioning: null,
		pricingModel: null,
		targetCustomer: null,
		notableCustomers: [],
		recentNews: [],
	});

type ResearchBrief = z.infer<typeof researchBrief>;

export default defineTool({
	description:
		"Read a company's marketing site and write a research brief to its timeline: positioning, pricing, who they sell to, notable customers, recent news.",
	inputSchema: z.object({
		companyId: z.string(),
	}),
	async execute({ companyId }) {
		const company = await db.company.findUnique({
			where: { id: companyId },
			select: {
				id: true,
				name: true,
				domain: true,
				website: true,
				ownerId: true,
			},
		});

		if (!company)
			return { written: false as const, reason: "No such company." };

		const url =
			company.website ?? (company.domain ? `https://${company.domain}` : null);

		if (!url) {
			return {
				written: false as const,
				reason: "This company has no website.",
			};
		}

		const charge = spend(2);
		if (!charge.ok) return { written: false as const, reason: charge.reason };

		const result = await extract(url, RESEARCH_SCHEMA, RESEARCH_INSTRUCTIONS);

		// The site is the only source this brief could come from. When it cannot
		// be read, do not let the session carry on reasoning from nothing: close
		// the task, latch the writes shut, and say plainly there is no source.
		if (result.outcome === "failed") {
			return sourceUnavailable(company.id, url, result.reason);
		}

		// A 200 that carries nothing is the same as an unreachable site: there is
		// no source. Parse it into the domain shape first, then judge it there.
		const scalar = briefScalar.parse(result.data);
		const body =
			scalar === null
				? formatBrief(researchBrief.parse(result.data))
				: String(scalar).trim();

		if (body.length === 0) {
			return sourceUnavailable(
				company.id,
				url,
				"the site returned nothing usable.",
			);
		}

		const author =
			company.ownerId ??
			(await db.user.findFirst({ select: { id: true } }))?.id ??
			null;

		if (!author)
			return { written: false as const, reason: "No user to attribute to." };

		const activity = await db.activity.create({
			data: {
				type: ActivityType.ENRICHMENT,
				subject: `Research brief — ${company.name}`,
				body,
				occurredAt: new Date(),
				companyId: company.id,
				createdById: author,
				meta: {
					source: "context.dev",
					endpoint: "web/extract",
					creditCost: 10,
					agent: "people-research",
				},
			},
			select: { id: true },
		});

		await db.company.update({
			where: { id: companyId },
			data: { lastActivityAt: new Date() },
		});

		return { written: true as const, activityId: activity.id };
	},
});

async function sourceUnavailable(companyId: string, url: string, why: string) {
	const failure = await failForMissingSource({ url, reason: why, companyId });

	return {
		written: false as const,
		sourceUnavailable: true as const,
		taskClosed: failure.taskClosed,
		reason: failure.taskClosed
			? `${failure.outcome} This task is now closed — stop here. Do not write fields, a brief, or facts about this company from memory or inference.`
			: `${url} could not be read (${why}). Write nothing about this company that you have not read from a source.`,
	};
}

function formatBrief(brief: ResearchBrief): string {
	const lines: string[] = [];

	if (brief.positioning) lines.push(brief.positioning);
	if (brief.pricingModel) lines.push(`Pricing: ${brief.pricingModel}`);
	if (brief.targetCustomer) lines.push(`Sells to: ${brief.targetCustomer}`);

	if (brief.notableCustomers.length > 0) {
		lines.push(`Customers: ${brief.notableCustomers.join(", ")}`);
	}

	if (brief.recentNews.length > 0) {
		lines.push(
			`Recently:\n${brief.recentNews.map((item) => `• ${item}`).join("\n")}`,
		);
	}

	return lines.join("\n\n");
}
