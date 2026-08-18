ALTER TABLE "email_channels"
  ADD COLUMN "sendgrid_api_key" TEXT,
  ADD COLUMN "sendgrid_api_base_url" TEXT,
  ADD COLUMN "sendgrid_webhook_verification_key" TEXT;

ALTER TABLE "sender_domains"
  ADD COLUMN "sendgrid_domain_id" TEXT;

ALTER TABLE "email_channels" DROP CONSTRAINT IF EXISTS "email_channels_provider_check";
ALTER TABLE "email_channels"
  ADD CONSTRAINT "email_channels_provider_check" CHECK ("provider" IN ('acs', 'mailgun', 'resend', 'cloudflare', 'sendgrid'));

CREATE INDEX "sender_domains_sendgrid_domain_id_idx" ON "sender_domains"("sendgrid_domain_id");
