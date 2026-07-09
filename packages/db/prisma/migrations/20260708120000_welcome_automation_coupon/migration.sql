-- Optional coupon shown in single-email automations such as customer welcome.
-- Null = no coupon; discount fields are snapshots for rendering the email card.
ALTER TABLE "shop_automations" ADD COLUMN "coupon_code" TEXT;
ALTER TABLE "shop_automations" ADD COLUMN "coupon_discount_kind" TEXT;
ALTER TABLE "shop_automations" ADD COLUMN "coupon_discount_value" DOUBLE PRECISION;
