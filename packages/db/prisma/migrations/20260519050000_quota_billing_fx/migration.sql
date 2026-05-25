-- FX rate cache + per-order CNY snapshot.
--
-- Domestic Alipay merchant: total_amount must be CNY, so every order
-- quote needs a USD→CNY conversion at the rate of the moment. We
-- (a) cache rates daily in fx_rates, and (b) snapshot the rate used on
-- each QuotaOrder so historical orders read back correctly even after
-- the daily rate moves.

CREATE TABLE "fx_rates" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "base"        TEXT         NOT NULL,
    "quote"       TEXT         NOT NULL,
    "rate"        NUMERIC(12,6) NOT NULL,
    "source"      TEXT         NOT NULL,
    "fetched_at"  TIMESTAMP(3) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fx_rates_base_quote_fetched_at_idx"
    ON "fx_rates"("base", "quote", "fetched_at" DESC);

-- Add CNY snapshot to orders. Backfill with 0 for any existing row (we
-- don't have any paid orders yet — the seed migration only created the
-- tier table, and the only deployed orders so far are 503'd attempts
-- that were never written). Drop the default after backfill so future
-- inserts must supply a real value.
ALTER TABLE "quota_orders" ADD COLUMN "amount_cny" NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "quota_orders" ADD COLUMN "fx_rate"    NUMERIC(12,6) NOT NULL DEFAULT 0;
ALTER TABLE "quota_orders" ALTER COLUMN "amount_cny" DROP DEFAULT;
ALTER TABLE "quota_orders" ALTER COLUMN "fx_rate"    DROP DEFAULT;
