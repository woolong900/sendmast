-- Allow the append-only ACS send log to represent both campaign recipients and
-- first-class shop automation sends.
ALTER TABLE "send_logs"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'campaign',
  ADD COLUMN "automation_id" UUID,
  ADD COLUMN "automation_send_id" UUID,
  ALTER COLUMN "campaign_id" DROP NOT NULL,
  ALTER COLUMN "recipient_id" DROP NOT NULL;

ALTER TABLE "send_logs"
  ADD CONSTRAINT "send_logs_automation_id_fkey"
    FOREIGN KEY ("automation_id") REFERENCES "shop_automations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "send_logs_automation_send_id_fkey"
    FOREIGN KEY ("automation_send_id") REFERENCES "shop_automation_sends"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "send_logs_automation_id_sent_at_idx"
  ON "send_logs"("automation_id", "sent_at");
CREATE INDEX "send_logs_automation_send_id_sent_at_idx"
  ON "send_logs"("automation_send_id", "sent_at");
CREATE INDEX "send_logs_source_sent_at_idx"
  ON "send_logs"("source", "sent_at");
