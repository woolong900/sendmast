ALTER TABLE "acs_accounts"
  ADD COLUMN "provider" VARCHAR(16) NOT NULL DEFAULT 'acs',
  ADD COLUMN "mailgun_api_key" TEXT,
  ADD COLUMN "mailgun_api_base_url" TEXT,
  ADD COLUMN "mailgun_webhook_signing_key" TEXT;

ALTER TABLE "acs_accounts"
  ADD CONSTRAINT "acs_accounts_provider_check" CHECK ("provider" IN ('acs', 'mailgun'));

ALTER TYPE "acs_account_status" RENAME TO "email_channel_status";

ALTER TABLE "acs_accounts" RENAME TO "email_channels";
ALTER TABLE "account_acs_accounts" RENAME TO "account_email_channels";

ALTER TABLE "account_email_channels" RENAME COLUMN "acs_account_id" TO "email_channel_id";
ALTER TABLE "sender_domains" RENAME COLUMN "acs_account_id" TO "email_channel_id";
ALTER TABLE "campaign_recipients" RENAME COLUMN "acs_account_id" TO "email_channel_id";
ALTER TABLE "send_logs" RENAME COLUMN "acs_account_id" TO "email_channel_id";
ALTER TABLE "shop_automation_sends" RENAME COLUMN "acs_account_id" TO "email_channel_id";

ALTER TABLE "email_channels" RENAME CONSTRAINT "acs_accounts_provider_check" TO "email_channels_provider_check";

ALTER INDEX IF EXISTS "acs_accounts_is_default_unique" RENAME TO "email_channels_is_default_unique";
ALTER INDEX IF EXISTS "account_acs_accounts_acs_account_id_idx" RENAME TO "account_email_channels_email_channel_id_idx";
ALTER INDEX IF EXISTS "sender_domains_acs_account_id_idx" RENAME TO "sender_domains_email_channel_id_idx";
ALTER INDEX IF EXISTS "campaign_recipients_acs_account_id_status_idx" RENAME TO "campaign_recipients_email_channel_id_status_idx";
ALTER INDEX IF EXISTS "send_logs_acs_account_id_ok_sent_at_idx" RENAME TO "send_logs_email_channel_id_ok_sent_at_idx";
