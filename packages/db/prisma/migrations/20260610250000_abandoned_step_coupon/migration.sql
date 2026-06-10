-- Per-round coupon for abandoned-cart recall. Null = no coupon (block hidden).
ALTER TABLE "shop_automation_steps" ADD COLUMN "coupon_code" TEXT;
