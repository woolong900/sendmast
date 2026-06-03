-- Multi-ACS-per-tenant: replace Account.default_acs_account_id single FK with a
-- many-to-many join table, and stamp each campaign recipient with its routed ACS.

-- 1. Tenant <-> ACS join table.
CREATE TABLE "account_acs_accounts" (
  "account_id"     UUID NOT NULL,
  "acs_account_id" UUID NOT NULL,
  "is_primary"     BOOLEAN NOT NULL DEFAULT false,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_acs_accounts_pkey" PRIMARY KEY ("account_id", "acs_account_id")
);

CREATE INDEX "account_acs_accounts_acs_account_id_idx"
  ON "account_acs_accounts" ("acs_account_id");

-- At most one primary ACS per tenant.
CREATE UNIQUE INDEX "account_acs_accounts_one_primary_per_account"
  ON "account_acs_accounts" ("account_id")
  WHERE "is_primary" = true;

ALTER TABLE "account_acs_accounts"
  ADD CONSTRAINT "account_acs_accounts_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_acs_accounts"
  ADD CONSTRAINT "account_acs_accounts_acs_account_id_fkey"
  FOREIGN KEY ("acs_account_id") REFERENCES "acs_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Backfill: each tenant's existing default ACS becomes its primary assignment.
INSERT INTO "account_acs_accounts" ("account_id", "acs_account_id", "is_primary")
SELECT "id", "default_acs_account_id", true
FROM "accounts"
WHERE "default_acs_account_id" IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3. Per-recipient ACS routing column.
ALTER TABLE "campaign_recipients" ADD COLUMN "acs_account_id" UUID;
CREATE INDEX "campaign_recipients_acs_account_id_status_idx"
  ON "campaign_recipients" ("acs_account_id", "status");

-- 4. Backfill in-flight sends: resolve ACS from the (recipient or campaign)
--    from-address domain. NULLs that remain are handled by the dispatcher.
UPDATE "campaign_recipients" cr
SET "acs_account_id" = sd."acs_account_id"
FROM "campaigns" c, "sender_domains" sd
WHERE cr."campaign_id" = c."id"
  AND sd."account_id" = c."account_id"
  AND sd."domain" = lower(split_part(COALESCE(cr."from_email", c."from_email"), '@', 2))
  AND c."status" = 'sending'
  AND cr."status" IN ('pending', 'queued')
  AND cr."acs_account_id" IS NULL;

-- 5. Drop the obsolete single-FK column (also drops its index + FK constraint).
ALTER TABLE "accounts" DROP COLUMN "default_acs_account_id";
