-- Denormalised paid/shipped order metrics for dynamic segments.

-- AlterTable
ALTER TABLE "contacts"
  ADD COLUMN "order_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "order_amount" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- Backfill from already-ingested paid/shipped orders.
UPDATE "contacts" c
SET
  "order_count" = s.order_count,
  "order_amount" = s.order_amount
FROM (
  SELECT
    "contact_id",
    COUNT(*)::INTEGER AS order_count,
    COALESCE(SUM("value"), 0)::DECIMAL(18,2) AS order_amount
  FROM "shop_orders"
  WHERE "status" IN ('paid', 'shipped') AND "contact_id" IS NOT NULL
  GROUP BY "contact_id"
) s
WHERE c.id = s."contact_id";

-- CreateIndex
CREATE INDEX "contacts_account_id_order_count_idx" ON "contacts"("account_id", "order_count");
CREATE INDEX "contacts_account_id_order_amount_idx" ON "contacts"("account_id", "order_amount");
