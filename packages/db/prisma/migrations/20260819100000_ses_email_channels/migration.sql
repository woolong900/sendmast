ALTER TABLE "email_channels"
  ADD COLUMN "ses_access_key_id" TEXT,
  ADD COLUMN "ses_secret_access_key" TEXT,
  ADD COLUMN "ses_region" TEXT;

ALTER TABLE "email_channels" DROP CONSTRAINT IF EXISTS "email_channels_provider_check";
ALTER TABLE "email_channels"
  ADD CONSTRAINT "email_channels_provider_check" CHECK ("provider" IN ('acs', 'mailgun', 'resend', 'cloudflare', 'sendgrid', 'ses'));
