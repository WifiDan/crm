-- Slice 2a: audit trail for guarded lead decisions and rework requests. Additive only.
CREATE TYPE "LgDecisionAction" AS ENUM ('DECISION', 'REWORK');

CREATE TYPE "LgDecisionStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED', 'UNKNOWN');

CREATE TABLE "lg_lead_decision" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" "LgDecisionAction" NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorEmail" TEXT,
    "leadId" TEXT NOT NULL,
    "nocodbTable" TEXT NOT NULL,
    "nocodbRowId" INTEGER NOT NULL,
    "stage" TEXT,
    "decision" TEXT,
    "notes" TEXT,
    "prevDecision" TEXT,
    "prevSendApproved" BOOLEAN,
    "prevVersion" TEXT,
    "patch" JSONB NOT NULL,
    "status" "LgDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "lg_lead_decision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lg_lead_decision_requestId_key" ON "lg_lead_decision"("requestId");

CREATE INDEX "lg_lead_decision_leadId_createdAt_idx" ON "lg_lead_decision"("leadId", "createdAt");

CREATE INDEX "lg_lead_decision_status_idx" ON "lg_lead_decision"("status");
