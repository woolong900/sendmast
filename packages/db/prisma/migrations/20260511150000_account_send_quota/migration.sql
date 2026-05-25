-- Tenant-level prepaid send quota. Default 0 — admins must top up explicitly.
ALTER TABLE "accounts"
  ADD COLUMN "send_quota_remaining" INTEGER NOT NULL DEFAULT 0;
