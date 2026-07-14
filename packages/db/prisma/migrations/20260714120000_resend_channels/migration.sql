ALTER TABLE "email_channels"
  ADD COLUMN "resend_api_key" TEXT,
  ADD COLUMN "resend_api_base_url" TEXT;

ALTER TABLE "sender_domains"
  ADD COLUMN "resend_domain_id" TEXT;

ALTER TABLE "email_channels" DROP CONSTRAINT IF EXISTS "email_channels_provider_check";
ALTER TABLE "email_channels"
  ADD CONSTRAINT "email_channels_provider_check" CHECK ("provider" IN ('acs', 'mailgun', 'resend'));

CREATE INDEX "sender_domains_resend_domain_id_idx" ON "sender_domains"("resend_domain_id");
