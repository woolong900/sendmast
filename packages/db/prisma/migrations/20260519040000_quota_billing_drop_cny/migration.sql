-- Drop CNY columns: pricing is now USD-only, settled via Alipay's
-- cross-border channel (currency=USD in biz_content). Customers still
-- pay CNY at Alipay's quoted FX rate; we just don't track CNY ourselves.
--
-- Safe to drop because the previous migration only seeded 9 tiers and
-- no real (paid) orders carry CNY values that we'd lose.

ALTER TABLE "quota_pricing_tiers" DROP COLUMN "price_cny";
ALTER TABLE "quota_orders"        DROP COLUMN "amount_cny";
