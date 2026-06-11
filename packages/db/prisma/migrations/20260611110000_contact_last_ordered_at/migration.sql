-- Denormalised "has ordered" marker: contacts.last_ordered_at = latest PAID
-- shop-order time (null = never ordered). Kept current by worker-shop-sync on
-- paid/shipped webhooks and the initial full sync; the segment `order` rule
-- compiles to a plain WHERE on this column.

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN "last_ordered_at" TIMESTAMP(3);

-- Backfill from already-ingested paid orders.
UPDATE "contacts" c
SET "last_ordered_at" = s.max_time
FROM (
  SELECT "contact_id", MAX("order_time") AS max_time
  FROM "shop_orders"
  WHERE "status" IN ('paid', 'shipped') AND "contact_id" IS NOT NULL
  GROUP BY "contact_id"
) s
WHERE c.id = s."contact_id";

-- CreateIndex
CREATE INDEX "contacts_account_id_last_ordered_at_idx" ON "contacts"("account_id", "last_ordered_at");
