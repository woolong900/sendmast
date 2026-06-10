-- Hard attribution of orders to an abandoned-cart flow: the recall CTA link
-- carries sm_mid=<send id>, echoed back in the order's landing_page; we resolve
-- it to the flow send that drove the conversion.
ALTER TABLE "shop_orders" ADD COLUMN "attributed_automation_id" UUID;
ALTER TABLE "shop_orders" ADD COLUMN "attributed_send_id" UUID;
CREATE INDEX "shop_orders_attributed_automation_id_idx" ON "shop_orders" ("attributed_automation_id");
