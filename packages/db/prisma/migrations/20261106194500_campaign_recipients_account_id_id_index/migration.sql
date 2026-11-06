-- Event segments resolve historical recipient ids back to contacts in bounded
-- chunks. Pair the tenant predicate with the recipient primary key so large
-- accounts do not scan the whole hot recipient table for every chunk.
-- Create this index CONCURRENTLY on production before deploying; IF NOT EXISTS
-- then makes this migration a no-op.
CREATE INDEX IF NOT EXISTS "campaign_recipients_account_id_id_idx"
ON "campaign_recipients"("account_id", "id");
