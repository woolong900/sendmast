-- Existing rows default to false: we don't know who created their SES
-- identity, so deleting them in SendMast no longer deletes it from SES.
ALTER TABLE "sender_domains" ADD COLUMN "ses_identity_created" BOOLEAN NOT NULL DEFAULT false;
