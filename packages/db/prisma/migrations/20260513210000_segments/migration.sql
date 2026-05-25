-- Dynamic audiences. `definition` holds a versioned JSON tree validated in
-- application code (SegmentDefinitionSchema). cached_count / cached_at are
-- display-only optimisations refreshed on demand; the campaign send path
-- always re-evaluates from scratch so a stale cache cannot cause a wrong-
-- audience send.
CREATE TABLE "segments" (
    "id"           UUID         PRIMARY KEY,
    "account_id"   UUID         NOT NULL,
    "name"         TEXT         NOT NULL,
    "description"  TEXT,
    "definition"   JSONB        NOT NULL,
    "cached_count" INTEGER,
    "cached_at"    TIMESTAMP(3),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "segments_account_id_fkey"
        FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "segments_account_id_name_key" ON "segments" ("account_id", "name");
CREATE INDEX "segments_account_id_created_at_idx" ON "segments" ("account_id", "created_at");

-- M:N join: a campaign can target zero or more segments (in addition to
-- zero or more contact_lists). At least one of the two must be non-empty —
-- enforced in application code at send time, not in SQL.
CREATE TABLE "campaign_segments" (
    "campaign_id" UUID NOT NULL,
    "segment_id"  UUID NOT NULL,
    PRIMARY KEY ("campaign_id", "segment_id"),
    CONSTRAINT "campaign_segments_campaign_id_fkey"
        FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "campaign_segments_segment_id_fkey"
        FOREIGN KEY ("segment_id") REFERENCES "segments"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "campaign_segments_segment_id_idx" ON "campaign_segments" ("segment_id");
