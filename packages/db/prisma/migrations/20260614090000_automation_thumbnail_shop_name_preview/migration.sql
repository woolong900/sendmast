UPDATE "email_templates"
SET "thumbnail" = regexp_replace("thumbnail", '\?.*$', '') || '?v=20260614',
    "updated_at" = now()
WHERE "id" IN (
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007'
)
  AND "thumbnail" IS NOT NULL
  AND "thumbnail" NOT LIKE '%?v=20260614';

UPDATE "shop_automations"
SET "thumbnail" = regexp_replace("thumbnail", '\?.*$', '') || '?v=20260614',
    "updated_at" = now()
WHERE "type" IN (
  'customer_registered'::"shop_automation_type",
  'order_paid'::"shop_automation_type",
  'order_shipped'::"shop_automation_type",
  'abandoned_cart'::"shop_automation_type"
)
  AND "thumbnail" IS NOT NULL
  AND "thumbnail" LIKE '%/assets/system-template-thumbnails/%'
  AND "thumbnail" NOT LIKE '%?v=20260614';

UPDATE "shop_automation_steps"
SET "thumbnail" = regexp_replace("thumbnail", '\?.*$', '') || '?v=20260614',
    "updated_at" = now()
WHERE "thumbnail" IS NOT NULL
  AND "thumbnail" LIKE '%/assets/system-template-thumbnails/%'
  AND "thumbnail" NOT LIKE '%?v=20260614';
