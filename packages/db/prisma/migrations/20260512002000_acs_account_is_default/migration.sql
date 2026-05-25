-- Platform-wide default ACS account for new tenant signups.
-- Partial unique index ensures at most one row is the default at a time.
ALTER TABLE "acs_accounts"
  ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "acs_accounts_is_default_unique"
  ON "acs_accounts" ("is_default")
  WHERE "is_default" = true;
