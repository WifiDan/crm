-- AlterTable
ALTER TABLE "lg_outreach_send" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "lg_outreach_send_dedupeKey_key" ON "lg_outreach_send"("dedupeKey");
