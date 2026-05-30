-- Multi-sender campaigns: a campaign may rotate through several "from"
-- addresses. The primary (position 0) still lives on campaigns.from_email/
-- from_name; the rest live here. Each recipient gets one assigned at
-- materialisation time (round-robin), stored on campaign_recipients.

CREATE TABLE "campaign_senders" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "campaign_id" UUID NOT NULL,
  "from_email"  TEXT NOT NULL,
  "from_name"   TEXT NOT NULL,
  "position"    INTEGER NOT NULL,
  CONSTRAINT "campaign_senders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campaign_senders_campaign_id_from_email_key"
  ON "campaign_senders" ("campaign_id", "from_email");
CREATE INDEX "campaign_senders_campaign_id_idx"
  ON "campaign_senders" ("campaign_id");

ALTER TABLE "campaign_senders"
  ADD CONSTRAINT "campaign_senders_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "campaigns" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-recipient assigned sender. NULL = fall back to campaign default.
ALTER TABLE "campaign_recipients"
  ADD COLUMN "from_email" TEXT,
  ADD COLUMN "from_name"  TEXT;
