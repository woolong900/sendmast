-- Persist the user's list-selection order so {{list_name}} can resolve a
-- recipient in multiple target lists to the FIRST one they belong to.
ALTER TABLE "campaign_lists" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
