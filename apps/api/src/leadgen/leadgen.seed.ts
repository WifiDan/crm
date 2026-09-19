import { type Db } from "@crm/db";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { nextRunAfter } from "./schedule";

/**
 * Idempotent seed for the three existing markets, two campaigns and the
 * first scheduled job. Never overwrites a row that already exists, so a
 * human edit in the UI survives a restart.
 */
@Injectable()
export class LeadgenSeedService implements OnModuleInit {
	private readonly logger = new Logger(LeadgenSeedService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async onModuleInit(): Promise<void> {
		try {
			await this.seed();
		} catch (error) {
			// Tables absent (migration not yet deployed) must not stop the CRM booting.
			this.logger.warn({
				message: "Lead-gen seed skipped",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async seed(): Promise<void> {
		const markets = [
			{
				name: "Plateau Valley",
				kind: "GEO" as const,
				geoCenter: "Collbran, CO",
				geoRadiusKm: 40,
				notes: "Elite Broadband Plateau Valley footprint. UISP + Google Places.",
			},
			{
				name: "Montrose",
				kind: "GEO" as const,
				geoCenter: "Montrose, CO",
				geoRadiusKm: 40,
				notes: "Azotel/SIMPLer + Google Places. Azotel connector must run from Joshua.",
			},
			{
				name: "Gyms (nationwide)",
				kind: "VERTICAL" as const,
				verticalSlug: "gyms",
				notes: "Independent gyms, cold outbound.",
			},
		];
		for (const m of markets) {
			const found = await this.db.lgMarket.findFirst({ where: { name: m.name } });
			if (!found) {
				await this.db.lgMarket.create({ data: { ...m, status: "ACTIVE" } });
			}
		}

		// ISP: 997 build + 35/mo per OUTREACH-TEMPLATES.md. Gym: EI-Pricing-Sheet.pdf
		// list price (Starter 1750, Partner 249/mo); the 875 figure is a Sept-2026
		// promo that expires 2026-09-30, so it is deliberately not stored here.
		const campaigns = [
			{
				name: "ISP facelift",
				offerPrice: "997",
				offerMonthly: "35",
				sendCapPerDay: 10,
				followupDays: [7, 28],
				fromIdentity: "danio@elitesystemsdesign.com",
			},
			{
				name: "Gym bundle",
				offerPrice: "1750",
				offerMonthly: "249",
				sendCapPerDay: 10,
				followupDays: [7, 28],
				fromIdentity: "danio@elitesystemsdesign.com",
			},
		];
		for (const c of campaigns) {
			const found = await this.db.lgCampaign.findUnique({ where: { name: c.name } });
			if (!found) await this.db.lgCampaign.create({ data: c });
		}

		const mirror = await this.db.lgJobDefinition.findUnique({
			where: { name: "nocodb.mirror" },
		});
		if (!mirror) {
			const spec = {
				scheduleKind: "INTERVAL" as const,
				intervalSeconds: 900,
				dailyAt: null,
				timezone: "America/Denver",
			};
			await this.db.lgJobDefinition.create({
				data: {
					name: "nocodb.mirror",
					description:
						"Read-only mirror of the NocoDB ISP + gym lead tables into lg_lead, with count assertions.",
					...spec,
					timeoutSeconds: 600,
					maxAgeSeconds: 3600,
					nextRunAt: nextRunAfter(spec, new Date()),
				},
			});
		}
	}
}
