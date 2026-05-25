-- Self-service quota top-up: pricing tiers + orders ledger.
--
-- Why two tables instead of bolting onto Account: top-up has a state machine
-- (pending → paid / cancelled) plus a payment-provider audit trail; mixing
-- those concerns into the (currently dead-simple) Account row is a one-way
-- door. Tier table is editable in admin UI so prices can be repriced
-- without code deploys.

CREATE TABLE "quota_pricing_tiers" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "emails"      INT          NOT NULL,
    "price_usd"   NUMERIC(10,2) NOT NULL,
    "price_cny"   NUMERIC(10,2) NOT NULL,
    "active"      BOOLEAN      NOT NULL DEFAULT true,
    "sort_order"  INT          NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "quota_pricing_tiers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "quota_pricing_tiers_active_sort_order_idx"
    ON "quota_pricing_tiers"("active", "sort_order");

CREATE TABLE "quota_orders" (
    "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
    "account_id"         UUID         NOT NULL,
    "tier_id"            UUID,
    "emails"             INT          NOT NULL,
    "amount_usd"         NUMERIC(10,2) NOT NULL,
    "amount_cny"         NUMERIC(10,2) NOT NULL,
    "status"             TEXT         NOT NULL DEFAULT 'pending',
    "provider"           TEXT         NOT NULL DEFAULT 'alipay',
    "provider_order_id"  TEXT         NOT NULL,
    "provider_trade_no"  TEXT,
    "paid_at"            TIMESTAMP(3),
    "created_by"         UUID,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "quota_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quota_orders_provider_order_id_key"
    ON "quota_orders"("provider_order_id");
CREATE INDEX "quota_orders_account_id_created_at_idx"
    ON "quota_orders"("account_id", "created_at" DESC);
CREATE INDEX "quota_orders_status_created_at_idx"
    ON "quota_orders"("status", "created_at");

ALTER TABLE "quota_orders"
    ADD CONSTRAINT "quota_orders_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quota_orders"
    ADD CONSTRAINT "quota_orders_tier_id_fkey"
    FOREIGN KEY ("tier_id") REFERENCES "quota_pricing_tiers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the 9 default tiers (matches Mailmaster pricing screenshot the user
-- referenced; CNY column assumes 7.20 USD→CNY which admins can later edit
-- per-row in the admin UI).
INSERT INTO "quota_pricing_tiers" ("id", "emails", "price_usd", "price_cny", "sort_order", "updated_at") VALUES
    (gen_random_uuid(), 10000,    18,    129.60,   10, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 30000,    48,    345.60,   20, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 50000,    70,    504.00,   30, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 100000,   130,   936.00,   40, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 300000,   360,   2592.00,  50, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 500000,   550,   3960.00,  60, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 1000000,  1000,  7200.00,  70, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 5000000,  4750,  34200.00, 80, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 10000000, 9000,  64800.00, 90, CURRENT_TIMESTAMP);
