-- Slice 2b: audit trail for demo HTML edits. Additive only (one new table, existing enum reused).
CREATE TABLE "lg_demo_edit" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorEmail" TEXT,
    "leadId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "bytesBefore" INTEGER NOT NULL,
    "sha256Before" TEXT NOT NULL,
    "bytesAfter" INTEGER NOT NULL,
    "sha256After" TEXT NOT NULL,
    "backupName" TEXT NOT NULL,
    "status" "LgDecisionStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "lg_demo_edit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lg_demo_edit_requestId_key" ON "lg_demo_edit"("requestId");

CREATE INDEX "lg_demo_edit_leadId_createdAt_idx" ON "lg_demo_edit"("leadId", "createdAt");

CREATE INDEX "lg_demo_edit_slug_createdAt_idx" ON "lg_demo_edit"("slug", "createdAt");

CREATE INDEX "lg_demo_edit_status_idx" ON "lg_demo_edit"("status");
