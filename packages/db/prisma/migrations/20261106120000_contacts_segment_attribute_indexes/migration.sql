-- Indexes for segment attribute rules (country / language).
--
-- On a large contacts table, build them WITHOUT blocking writes BEFORE
-- deploying (Prisma runs migrations in a way that does not allow
-- CONCURRENTLY), e.g.:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_account_id_country_idx"  ON "contacts"("account_id", "country");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_account_id_language_idx" ON "contacts"("account_id", "language");
-- These statements then become no-ops. Fresh / small databases build them here.
CREATE INDEX IF NOT EXISTS "contacts_account_id_country_idx" ON "contacts"("account_id", "country");
CREATE INDEX IF NOT EXISTS "contacts_account_id_language_idx" ON "contacts"("account_id", "language");
