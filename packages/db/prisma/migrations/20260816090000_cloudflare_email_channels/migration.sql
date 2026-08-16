ALTER TABLE "email_channels"
  ADD COLUMN "cloudflare_account_id" TEXT,
  ADD COLUMN "cloudflare_api_token" TEXT,
  ADD COLUMN "cloudflare_api_base_url" TEXT;

ALTER TABLE "email_channels" DROP CONSTRAINT IF EXISTS "email_channels_provider_check";
ALTER TABLE "email_channels"
  ADD CONSTRAINT "email_channels_provider_check" CHECK ("provider" IN ('acs', 'mailgun', 'resend', 'cloudflare'));
