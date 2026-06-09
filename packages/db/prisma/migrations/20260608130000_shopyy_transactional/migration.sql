-- Transactional / automation send support.
-- Hidden system campaigns back each triggered transactional email and carry
-- per-recipient merge values (order total, tracking url, ...) resolved into
-- system tags at send time.

ALTER TABLE "campaigns" ADD COLUMN "is_automation" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "campaign_recipients" ADD COLUMN "merge_vars" JSONB;
