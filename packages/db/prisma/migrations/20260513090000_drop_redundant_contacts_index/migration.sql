-- The `@@unique([accountId, email])` constraint already creates a btree
-- index on (account_id, email) — the explicit `@@index([accountId, email])`
-- emitted a second redundant index of exactly the same shape, doubling
-- write amplification on every contact insert/update with no read benefit.
-- Drop it; the unique-constraint index serves all the same lookups.
DROP INDEX IF EXISTS "contacts_account_id_email_idx";
