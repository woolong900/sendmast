UPDATE "shop_automations"
SET "thumbnail" = NULL,
    "updated_at" = now()
WHERE "type" IN (
  'customer_registered'::"shop_automation_type",
  'order_paid'::"shop_automation_type",
  'order_shipped'::"shop_automation_type",
  'abandoned_cart'::"shop_automation_type"
)
  AND "thumbnail" IS NOT NULL
  AND "thumbnail" NOT LIKE '%/assets/system-template-thumbnails/%?v=20260614';

UPDATE "shop_automation_steps"
SET "thumbnail" = NULL,
    "updated_at" = now()
WHERE "thumbnail" IS NOT NULL
  AND "thumbnail" NOT LIKE '%/assets/system-template-thumbnails/%?v=20260614';
