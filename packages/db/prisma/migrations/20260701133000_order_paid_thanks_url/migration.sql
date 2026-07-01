-- Order confirmation should point to the storefront thank-you page, not the
-- generic order/account URL. Limit the rewrite to order_paid automations and
-- the system order-confirmation template.
UPDATE "email_templates"
SET
  "html" = replace("html", '{{order_url}}', '{{thanks_url}}'),
  "mjml" = CASE
    WHEN "mjml" IS NULL THEN NULL
    ELSE replace("mjml", '{{order_url}}', '{{thanks_url}}')
  END,
  "design_json" = CASE
    WHEN "design_json" IS NULL THEN NULL
    ELSE replace("design_json"::text, '{{order_url}}', '{{thanks_url}}')::jsonb
  END,
  "updated_at" = now()
WHERE (
    "id" = '00000000-0000-4000-8000-000000000005'
    OR "id" IN (
      SELECT "template_id"
      FROM "shop_automations"
      WHERE "type" = 'order_paid' AND "template_id" IS NOT NULL
    )
  )
  AND (
    "html" LIKE '%{{order_url}}%'
    OR "mjml" LIKE '%{{order_url}}%'
    OR "design_json"::text LIKE '%{{order_url}}%'
  );

UPDATE "shop_automations"
SET
  "html" = CASE
    WHEN "html" IS NULL THEN NULL
    ELSE replace("html", '{{order_url}}', '{{thanks_url}}')
  END,
  "mjml" = CASE
    WHEN "mjml" IS NULL THEN NULL
    ELSE replace("mjml", '{{order_url}}', '{{thanks_url}}')
  END,
  "design_json" = CASE
    WHEN "design_json" IS NULL THEN NULL
    ELSE replace("design_json"::text, '{{order_url}}', '{{thanks_url}}')::jsonb
  END,
  "updated_at" = now()
WHERE "type" = 'order_paid'
  AND (
    "html" LIKE '%{{order_url}}%'
    OR "mjml" LIKE '%{{order_url}}%'
    OR "design_json"::text LIKE '%{{order_url}}%'
  );
