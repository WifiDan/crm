-- Phase 4 (shadow): one row per morning holding the CRM send plan and its comparison with Python. Additive only.
CREATE TABLE "lg_send_shadow_run" (
    "id" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "cap" INTEGER NOT NULL,
    "hold" JSONB,
    "candidates" JSONB NOT NULL,
    "planned" JSONB NOT NULL,
    "compare" JSONB,
    "comparedAt" TIMESTAMP(3),

    CONSTRAINT "lg_send_shadow_run_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lg_send_shadow_run_runDate_key" ON "lg_send_shadow_run"("runDate");
