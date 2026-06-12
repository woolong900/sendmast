-- Persist the exact Shopyy webhook rows created for each shop connection so
-- disconnect can delete them directly via /webhooks/batchdelete.

-- AlterTable
ALTER TABLE "shop_connections"
ADD COLUMN "webhook_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
