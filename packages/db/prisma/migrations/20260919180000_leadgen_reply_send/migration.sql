-- Phase 3c: authenticated reply-send path. Additive only.
ALTER TYPE "LgDraftStep" ADD VALUE IF NOT EXISTS 'REPLY';

ALTER TABLE "lg_outreach_send"
  ADD COLUMN "inReplyTo" TEXT,
  ADD COLUMN "referencesHeader" TEXT,
  ADD COLUMN "sentBy" TEXT;

ALTER TABLE "lg_reply_draft"
  ADD COLUMN "sentSubject" TEXT,
  ADD COLUMN "sentBody" TEXT,
  ADD COLUMN "sendError" TEXT;
