-- Marker table for the recipient-archive flow. One row per campaign whose
-- recipient detail has been moved into ClickHouse (see worker-sender's
-- archive-recipients cron). The recipient_count is recorded here for quick
-- "how many people did we send to?" queries without touching CH.
CREATE TABLE "campaign_archive_state" (
    "campaign_id"     UUID         PRIMARY KEY,
    "archived_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient_count" INTEGER      NOT NULL
);
