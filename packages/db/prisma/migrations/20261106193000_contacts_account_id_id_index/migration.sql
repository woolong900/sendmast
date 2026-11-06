-- Large tenants evaluate ClickHouse-derived contact id sets in bounded chunks.
-- Pairing the tenant predicate with the id lookup prevents PostgreSQL from
-- scanning every contact in the account before applying the id filter.
-- On production, create this index CONCURRENTLY before deploying; IF NOT EXISTS
-- then makes this migration a no-op.
CREATE INDEX IF NOT EXISTS "contacts_account_id_id_idx"
ON "contacts"("account_id", "id");
