-- Move provider trace from campaign_recipients (one-row-per-recipient)
-- to a dedicated append-only send_logs table.

ALTER TABLE "campaign_recipients"
  DROP COLUMN "provider_status",
  DROP COLUMN "provider_error_code",
  DROP COLUMN "provider_response",
  DROP COLUMN "provider_latency_ms";

CREATE TABLE "send_logs" (
  "id"                UUID PRIMARY KEY,
  "account_id"        UUID NOT NULL,
  "acs_account_id"    UUID,
  "campaign_id"       UUID NOT NULL,
  "recipient_id"      UUID NOT NULL,
  "from_address"      TEXT NOT NULL,
  "from_name"         TEXT,
  "to_address"        TEXT NOT NULL,
  "ok"                BOOLEAN NOT NULL,
  "provider_status"   TEXT,
  "message_id"        TEXT,
  "error_code"        TEXT,
  "error_message"     TEXT,
  "latency_ms"        INTEGER,
  "response_payload"  JSONB,
  "sent_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "send_logs_account_id_fkey"
    FOREIGN KEY ("account_id")     REFERENCES "accounts"("id")             ON DELETE CASCADE,
  CONSTRAINT "send_logs_acs_account_id_fkey"
    FOREIGN KEY ("acs_account_id") REFERENCES "acs_accounts"("id")         ON DELETE SET NULL,
  CONSTRAINT "send_logs_campaign_id_fkey"
    FOREIGN KEY ("campaign_id")    REFERENCES "campaigns"("id")            ON DELETE CASCADE,
  CONSTRAINT "send_logs_recipient_id_fkey"
    FOREIGN KEY ("recipient_id")   REFERENCES "campaign_recipients"("id")  ON DELETE CASCADE
);

CREATE INDEX "send_logs_campaign_id_sent_at_idx"        ON "send_logs"("campaign_id", "sent_at");
CREATE INDEX "send_logs_recipient_id_sent_at_idx"       ON "send_logs"("recipient_id", "sent_at");
CREATE INDEX "send_logs_acs_account_id_ok_sent_at_idx"  ON "send_logs"("acs_account_id", "ok", "sent_at");
CREATE INDEX "send_logs_account_id_sent_at_idx"         ON "send_logs"("account_id", "sent_at");
