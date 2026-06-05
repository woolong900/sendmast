-- Capture the target list name(s) a recipient belongs to at materialisation
-- time so the {{list_name}} system tag resolves without a send-time join and
-- stays frozen against later membership changes.
ALTER TABLE "campaign_recipients" ADD COLUMN "list_name" TEXT;
