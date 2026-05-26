-- Add the two columns that let a refresh token carry the (account, impersonator)
-- pair across access-token rotation. Both are nullable: existing rows have no
-- way to know their original accountId post-hoc, so refresh code falls back to
-- the user's first AccountUser membership when account_id is NULL.
ALTER TABLE "refresh_tokens"
  ADD COLUMN "account_id" UUID,
  ADD COLUMN "impersonated_by" UUID;
