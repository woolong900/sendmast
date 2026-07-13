ALTER TABLE "account_email_channels"
  ADD COLUMN "allow_marketing" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "allow_transactional" BOOLEAN NOT NULL DEFAULT TRUE;
