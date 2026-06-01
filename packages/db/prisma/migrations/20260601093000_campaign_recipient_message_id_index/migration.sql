-- Index for resolving inbound ACS delivery reports by messageId.
-- We now pre-assign the ACS operationId (== the report's messageId) and write
-- it to campaign_recipients.message_id before sending, so every delivery report
-- resolves via this lookup. Without an index that lookup is a sequential scan.
CREATE INDEX IF NOT EXISTS "campaign_recipients_message_id_idx" ON "campaign_recipients"("message_id");
