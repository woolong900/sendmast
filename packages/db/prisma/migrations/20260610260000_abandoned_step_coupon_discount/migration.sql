-- Snapshot the chosen coupon's discount so the recall email can show "Save N%"
-- vs "Save $X" without re-fetching. kind: 'percent' | 'amount'.
ALTER TABLE "shop_automation_steps" ADD COLUMN "coupon_discount_kind" TEXT;
ALTER TABLE "shop_automation_steps" ADD COLUMN "coupon_discount_value" DOUBLE PRECISION;
