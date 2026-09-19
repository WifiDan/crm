-- Phase 3d: Sent-folder awareness. Additive only.
ALTER TABLE "lg_inbound_message"
  ADD COLUMN "answeredAt" TIMESTAMP(3),
  ADD COLUMN "answeredMessageId" TEXT,
  ADD COLUMN "answeredVia" TEXT;
