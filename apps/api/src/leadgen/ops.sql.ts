import { Prisma } from "@crm/db";
import { LEAD_VIEWS } from "./lead-views.config";
import { PROSPECT } from "./lead-views.sql";

type RawKey =
	| "Rework Requested"
	| "Email"
	| "Draft Email Subject"
	| "Draft Email Body";

const field = (name: RawKey) =>
	Prisma.sql`COALESCE(l.raw->>${Prisma.raw(`'${name}'`)}, '')`;

export const ACTIVE_LEAD = Prisma.sql`l."mirrorMissingAt" IS NULL`;

export const AWAITING_REVIEW = Prisma.sql`l."approvalDecision" IS NULL AND l."demoUrl" IS NOT NULL AND ${field("Rework Requested")} = ''`;

export const READY_TO_SEND = Prisma.sql`l."approvalDecision" = 'Approved'
	AND ${field("Email")} <> ''
	AND l."sentAt" IS NULL
	AND NOT l."doNotContact"
	AND ${field("Draft Email Subject")} <> ''
	AND ${field("Draft Email Body")} <> ''
	AND strpos(${field("Draft Email Subject")} || ${field("Draft Email Body")}, '{{') = 0`;

export const CALL_TEXT = Prisma.sql`l."approvalDecision" = 'Approved' AND ${field("Email")} = '' AND l."sentAt" IS NULL`;

export const REWORK_QUEUE = Prisma.sql`${field("Rework Requested")} <> ''`;

export const POOL_COUNTS = Prisma.sql`SELECT COALESCE(l."nocodbTable", '') AS k,
	count(*)::int AS total,
	count(*) FILTER (WHERE ${PROSPECT} AND l."approvalDecision" IS NULL)::int AS "pendingTriage",
	count(*) FILTER (WHERE l."demoUrl" IS NOT NULL)::int AS "sideBySideBuilt",
	count(*) FILTER (WHERE l."sentAt" IS NOT NULL)::int AS sent,
	count(*) FILTER (WHERE l."repliedAt" IS NOT NULL)::int AS replied,
	count(*) FILTER (WHERE ${AWAITING_REVIEW})::int AS "awaitingReview",
	count(*) FILTER (WHERE ${READY_TO_SEND})::int AS "readyToSend",
	count(*) FILTER (WHERE ${CALL_TEXT})::int AS "callText",
	count(*) FILTER (WHERE l."doNotContact")::int AS "doNotContact"
	FROM lg_lead l WHERE ${ACTIVE_LEAD} GROUP BY 1`;

export const BY_SOURCE = Prisma.sql`SELECT COALESCE(NULLIF(BTRIM(l.raw->>'Source'), ''), 'Unknown') AS k, count(*)::int AS n FROM lg_lead l WHERE ${ACTIVE_LEAD} GROUP BY 1`;

export const BY_DECISION = Prisma.sql`SELECT COALESCE(l."approvalDecision", 'pending') AS k, count(*)::int AS n FROM lg_lead l WHERE ${ACTIVE_LEAD} GROUP BY 1`;

const SINCE = Prisma.sql`(now() AT TIME ZONE 'UTC') - make_interval(days => ${LEAD_VIEWS.recentDays}::int)`;

export const DAILY_SENDS = Prisma.sql`SELECT to_char(t, 'YYYY-MM-DD') AS k, count(*)::int AS n
	FROM (
		SELECT s."sentAt" AS t FROM lg_outreach_send s WHERE s."sentAt" IS NOT NULL
		UNION ALL
		SELECT l."sentAt" AS t FROM lg_lead l
		WHERE l."sentAt" IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM lg_outreach_send s WHERE s."leadId" = l.id)
	) x
	WHERE t >= ${SINCE}
	GROUP BY 1 ORDER BY 1`;

export const PROSPECTOR_YIELD = Prisma.sql`SELECT left(l.raw->>'CreatedAt', 10) AS k, count(*)::int AS n
	FROM lg_lead l
	WHERE ${ACTIVE_LEAD} AND l.raw->>'Source' = 'Google Places'
	AND COALESCE(l.raw->>'CreatedAt', '') <> ''
	AND left(l.raw->>'CreatedAt', 10) >= to_char(${SINCE}, 'YYYY-MM-DD')
	GROUP BY 1 ORDER BY 1`;

export const REWORK_COUNT = Prisma.sql`SELECT count(*)::int AS n FROM lg_lead l WHERE ${ACTIVE_LEAD} AND ${REWORK_QUEUE}`;

export const reworkRows = (limit: number) =>
	Prisma.sql`SELECT l.id, l."businessName",
		NULLIF(l.raw->>'Rework Notes', '') AS notes,
		l.raw->>'Rework Requested' AS since
		FROM lg_lead l WHERE ${ACTIVE_LEAD} AND ${REWORK_QUEUE}
		ORDER BY l.raw->>'Rework Requested' DESC, l.id ASC LIMIT ${limit}`;
