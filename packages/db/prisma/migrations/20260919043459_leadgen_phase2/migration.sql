-- CreateEnum
CREATE TYPE "LgMarketKind" AS ENUM ('GEO', 'VERTICAL', 'LIST');

-- CreateEnum
CREATE TYPE "LgMarketStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "LgSourceType" AS ENUM ('GOOGLE_PLACES', 'UISP', 'AZOTEL', 'CSV', 'MANUAL', 'NOCODB_MIRROR');

-- CreateEnum
CREATE TYPE "LgLeadStage" AS ENUM ('NEW', 'SCREENED', 'APPROVED', 'REJECTED', 'BUILDING', 'BUILT', 'IN_REVIEW', 'REWORK', 'READY', 'SENT', 'REPLIED', 'CONVERTED', 'DEAD');

-- CreateEnum
CREATE TYPE "LgBuildStatus" AS ENUM ('QUEUED', 'RUNNING', 'OK', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LgDraftStep" AS ENUM ('INITIAL', 'FU1', 'FU2');

-- CreateEnum
CREATE TYPE "LgInboundClass" AS ENUM ('INTERESTED', 'QUESTION', 'NOT_NOW', 'STOP', 'BOUNCE_HARD', 'BOUNCE_SOFT', 'AUTO_REPLY', 'UNRELATED');

-- CreateEnum
CREATE TYPE "LgReplyDraftStatus" AS ENUM ('PENDING', 'APPROVED', 'EDITED', 'SENT', 'DISCARDED');

-- CreateEnum
CREATE TYPE "LgJobScheduleKind" AS ENUM ('INTERVAL', 'DAILY');

-- CreateEnum
CREATE TYPE "LgJobRunStatus" AS ENUM ('RUNNING', 'OK', 'FAILED', 'TIMED_OUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "LgAlertTier" AS ENUM ('PAGE', 'DIGEST', 'LOG');

-- CreateEnum
CREATE TYPE "SpClientPlan" AS ENUM ('BUILD_ONLY', 'BUILD_PLUS_HOSTING');

-- CreateEnum
CREATE TYPE "SpTicketStatus" AS ENUM ('NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SpTicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SpTicketCategory" AS ENUM ('CHANGE', 'BUG', 'QUESTION', 'NEW_FEATURE', 'BILLING');

-- CreateEnum
CREATE TYPE "SpTicketSource" AS ENUM ('EMAIL', 'PORTAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "SpMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');

-- CreateTable
CREATE TABLE "lg_market" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LgMarketKind" NOT NULL,
    "geoCenter" TEXT,
    "geoRadiusKm" DOUBLE PRECISION,
    "placeTypes" TEXT[],
    "keywords" TEXT[],
    "verticalSlug" TEXT,
    "status" "LgMarketStatus" NOT NULL DEFAULT 'DRAFT',
    "dailyProspectCap" INTEGER NOT NULL DEFAULT 25,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lg_market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "offerPrice" DECIMAL(14,2),
    "offerMonthly" DECIMAL(14,2),
    "sendCapPerDay" INTEGER NOT NULL DEFAULT 10,
    "followupDays" INTEGER[],
    "fromIdentity" TEXT,
    "dncScope" TEXT NOT NULL DEFAULT 'global',
    "status" TEXT NOT NULL DEFAULT 'active',
    "themeRef" TEXT,
    "playbookRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lg_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_market_campaign" (
    "marketId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,

    CONSTRAINT "lg_market_campaign_pkey" PRIMARY KEY ("marketId","campaignId")
);

-- CreateTable
CREATE TABLE "lg_source" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "type" "LgSourceType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastResultSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lg_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_lead" (
    "id" TEXT NOT NULL,
    "marketId" TEXT,
    "campaignId" TEXT,
    "sourceId" TEXT,
    "companyId" TEXT,
    "businessName" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "websiteUrl" TEXT,
    "demoUrl" TEXT,
    "hasWebsite" BOOLEAN,
    "qualityScore" INTEGER,
    "stage" "LgLeadStage" NOT NULL DEFAULT 'NEW',
    "approvalDecision" TEXT,
    "sendApproved" BOOLEAN NOT NULL DEFAULT false,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "dncReason" TEXT,
    "dncAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "hotLead" BOOLEAN NOT NULL DEFAULT false,
    "placeId" TEXT,
    "dedupeKey" TEXT,
    "nocodbTable" TEXT,
    "nocodbRowId" INTEGER,
    "raw" JSONB,
    "rawHash" TEXT,
    "mirroredAt" TIMESTAMP(3),
    "mirrorMissingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lg_lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_lead_contact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "discoveredVia" TEXT,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lg_lead_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_build" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "status" "LgBuildStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "outputPath" TEXT,
    "deployUrl" TEXT,
    "cfBranch" TEXT,
    "qaResult" JSONB,
    "reworkRequested" BOOLEAN NOT NULL DEFAULT false,
    "reworkNotes" TEXT,
    "expiresAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lg_build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_outreach_draft" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "step" "LgDraftStep" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lg_outreach_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_outreach_send" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "draftId" TEXT,
    "step" "LgDraftStep" NOT NULL,
    "toAddr" TEXT NOT NULL,
    "subject" TEXT,
    "messageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "smtpResponse" TEXT,
    "mimeSha256" TEXT,
    "source" TEXT NOT NULL DEFAULT 'python-send-log',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lg_outreach_send_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_inbound_message" (
    "id" TEXT NOT NULL,
    "imapUid" INTEGER,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "fromAddr" TEXT NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT,
    "receivedAt" TIMESTAMP(3),
    "matchedLeadId" TEXT,
    "matchedSendId" TEXT,
    "matchMethod" TEXT,
    "classification" "LgInboundClass",
    "classificationEvidence" TEXT,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "shadow" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lg_inbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_reply_draft" (
    "id" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "draftSubject" TEXT NOT NULL,
    "draftBody" TEXT NOT NULL,
    "rationale" TEXT,
    "status" "LgReplyDraftStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "sentSendId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lg_reply_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_job_definition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scheduleKind" "LgJobScheduleKind" NOT NULL,
    "intervalSeconds" INTEGER,
    "dailyAt" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Denver',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 900,
    "maxAgeSeconds" INTEGER NOT NULL DEFAULT 90000,
    "ownerModule" TEXT NOT NULL DEFAULT 'leadgen',
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lg_job_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_job_run" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "LgJobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "counters" JSONB,
    "error" TEXT,
    "logPointer" TEXT,

    CONSTRAINT "lg_job_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_alert" (
    "id" TEXT NOT NULL,
    "tier" "LgAlertTier" NOT NULL,
    "key" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "jobId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lg_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lg_llm_call" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "relatedType" TEXT,
    "relatedId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "estCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lg_llm_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_client" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "plan" "SpClientPlan" NOT NULL DEFAULT 'BUILD_ONLY',
    "hostingMonthly" DECIMAL(14,2),
    "liveSiteUrl" TEXT,
    "cfProject" TEXT,
    "onboardedAt" TIMESTAMP(3),
    "primaryContactId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_ticket" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "SpTicketCategory" NOT NULL DEFAULT 'QUESTION',
    "priority" "SpTicketPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "SpTicketStatus" NOT NULL DEFAULT 'NEW',
    "source" "SpTicketSource" NOT NULL DEFAULT 'EMAIL',
    "originMessageId" TEXT,
    "assignedTo" TEXT,
    "dueAt" TIMESTAMP(3),
    "slaBreachAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_ticket_message" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "direction" "SpMessageDirection" NOT NULL,
    "author" TEXT,
    "body" TEXT NOT NULL,
    "aiDrafted" BOOLEAN NOT NULL DEFAULT false,
    "reviewedBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sp_ticket_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lg_market_status_idx" ON "lg_market"("status");

-- CreateIndex
CREATE UNIQUE INDEX "lg_campaign_name_key" ON "lg_campaign"("name");

-- CreateIndex
CREATE INDEX "lg_source_marketId_idx" ON "lg_source"("marketId");

-- CreateIndex
CREATE INDEX "lg_lead_marketId_idx" ON "lg_lead"("marketId");

-- CreateIndex
CREATE INDEX "lg_lead_campaignId_idx" ON "lg_lead"("campaignId");

-- CreateIndex
CREATE INDEX "lg_lead_companyId_idx" ON "lg_lead"("companyId");

-- CreateIndex
CREATE INDEX "lg_lead_stage_idx" ON "lg_lead"("stage");

-- CreateIndex
CREATE INDEX "lg_lead_doNotContact_idx" ON "lg_lead"("doNotContact");

-- CreateIndex
CREATE INDEX "lg_lead_email_idx" ON "lg_lead"("email");

-- CreateIndex
CREATE INDEX "lg_lead_dedupeKey_idx" ON "lg_lead"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "lg_lead_nocodbTable_nocodbRowId_key" ON "lg_lead"("nocodbTable", "nocodbRowId");

-- CreateIndex
CREATE UNIQUE INDEX "lg_lead_contact_leadId_kind_value_key" ON "lg_lead_contact"("leadId", "kind", "value");

-- CreateIndex
CREATE INDEX "lg_build_leadId_idx" ON "lg_build"("leadId");

-- CreateIndex
CREATE INDEX "lg_build_status_idx" ON "lg_build"("status");

-- CreateIndex
CREATE UNIQUE INDEX "lg_outreach_draft_leadId_step_key" ON "lg_outreach_draft"("leadId", "step");

-- CreateIndex
CREATE UNIQUE INDEX "lg_outreach_send_messageId_key" ON "lg_outreach_send"("messageId");

-- CreateIndex
CREATE INDEX "lg_outreach_send_leadId_idx" ON "lg_outreach_send"("leadId");

-- CreateIndex
CREATE INDEX "lg_outreach_send_toAddr_idx" ON "lg_outreach_send"("toAddr");

-- CreateIndex
CREATE UNIQUE INDEX "lg_inbound_message_messageId_key" ON "lg_inbound_message"("messageId");

-- CreateIndex
CREATE INDEX "lg_inbound_message_matchedLeadId_idx" ON "lg_inbound_message"("matchedLeadId");

-- CreateIndex
CREATE INDEX "lg_inbound_message_classification_idx" ON "lg_inbound_message"("classification");

-- CreateIndex
CREATE INDEX "lg_reply_draft_status_idx" ON "lg_reply_draft"("status");

-- CreateIndex
CREATE INDEX "lg_reply_draft_leadId_idx" ON "lg_reply_draft"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "lg_job_definition_name_key" ON "lg_job_definition"("name");

-- CreateIndex
CREATE INDEX "lg_job_definition_enabled_nextRunAt_idx" ON "lg_job_definition"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "lg_job_run_jobId_startedAt_idx" ON "lg_job_run"("jobId", "startedAt");

-- CreateIndex
CREATE INDEX "lg_job_run_status_leaseExpiresAt_idx" ON "lg_job_run"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "lg_alert_tier_resolvedAt_idx" ON "lg_alert"("tier", "resolvedAt");

-- CreateIndex
CREATE INDEX "lg_alert_key_idx" ON "lg_alert"("key");

-- CreateIndex
CREATE INDEX "lg_llm_call_purpose_createdAt_idx" ON "lg_llm_call"("purpose", "createdAt");

-- CreateIndex
CREATE INDEX "sp_client_companyId_idx" ON "sp_client"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sp_ticket_number_key" ON "sp_ticket"("number");

-- CreateIndex
CREATE INDEX "sp_ticket_clientId_idx" ON "sp_ticket"("clientId");

-- CreateIndex
CREATE INDEX "sp_ticket_status_idx" ON "sp_ticket"("status");

-- CreateIndex
CREATE INDEX "sp_ticket_message_ticketId_idx" ON "sp_ticket_message"("ticketId");

-- AddForeignKey
ALTER TABLE "lg_market_campaign" ADD CONSTRAINT "lg_market_campaign_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "lg_market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_market_campaign" ADD CONSTRAINT "lg_market_campaign_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "lg_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_source" ADD CONSTRAINT "lg_source_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "lg_market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_lead" ADD CONSTRAINT "lg_lead_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "lg_market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_lead" ADD CONSTRAINT "lg_lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "lg_campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_lead" ADD CONSTRAINT "lg_lead_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "lg_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_lead" ADD CONSTRAINT "lg_lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_lead_contact" ADD CONSTRAINT "lg_lead_contact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lg_lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_build" ADD CONSTRAINT "lg_build_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lg_lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_outreach_draft" ADD CONSTRAINT "lg_outreach_draft_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lg_lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_outreach_send" ADD CONSTRAINT "lg_outreach_send_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lg_lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_outreach_send" ADD CONSTRAINT "lg_outreach_send_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "lg_outreach_draft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_inbound_message" ADD CONSTRAINT "lg_inbound_message_matchedLeadId_fkey" FOREIGN KEY ("matchedLeadId") REFERENCES "lg_lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_reply_draft" ADD CONSTRAINT "lg_reply_draft_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "lg_inbound_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_reply_draft" ADD CONSTRAINT "lg_reply_draft_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lg_lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lg_job_run" ADD CONSTRAINT "lg_job_run_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "lg_job_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sp_client" ADD CONSTRAINT "sp_client_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sp_ticket" ADD CONSTRAINT "sp_ticket_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "sp_client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sp_ticket_message" ADD CONSTRAINT "sp_ticket_message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "sp_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
