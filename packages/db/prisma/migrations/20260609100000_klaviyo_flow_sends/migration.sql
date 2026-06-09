-- Klaviyo-style alignment: automation emails become first-class, independently
-- tracked "flow sends" instead of borrowing a hidden campaign per send.

-- 1) Promote shop_automation_sends to the send unit.
ALTER TABLE "shop_automation_sends"
  ADD COLUMN "message_id"    TEXT,
  ADD COLUMN "acs_account_id" UUID,
  ADD COLUMN "from_email"    TEXT,
  ADD COLUMN "from_name"     TEXT,
  ADD COLUMN "subject"       TEXT,
  ADD COLUMN "merge_vars"    JSONB,
  ADD COLUMN "sent_at"       TIMESTAMP(3);

-- Old idempotency-ledger default was 'sent'; the send unit starts 'pending'.
ALTER TABLE "shop_automation_sends" ALTER COLUMN "status" SET DEFAULT 'pending';

-- recipient_id pointed at the now-removed hidden campaign recipient.
ALTER TABLE "shop_automation_sends" DROP COLUMN IF EXISTS "recipient_id";

CREATE INDEX "shop_automation_sends_message_id_idx"
  ON "shop_automation_sends" ("message_id");

-- 2) Drop the hidden-campaign borrow columns.
ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "is_automation";
ALTER TABLE "campaign_recipients" DROP COLUMN IF EXISTS "merge_vars";
