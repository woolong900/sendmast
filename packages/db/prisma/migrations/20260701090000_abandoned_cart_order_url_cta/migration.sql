-- Use the order/checkout URL merge var for abandoned-cart CTAs. The sender
-- still supplies tracking_url for backward compatibility with any old copies.
UPDATE "email_templates"
SET
  "html" = replace("html", '{{tracking_url}}', '{{order_url}}'),
  "mjml" = CASE
    WHEN "mjml" IS NULL THEN NULL
    ELSE replace("mjml", '{{tracking_url}}', '{{order_url}}')
  END,
  "design_json" = CASE
    WHEN "design_json" IS NULL THEN NULL
    ELSE replace("design_json"::text, '{{tracking_url}}', '{{order_url}}')::jsonb
  END,
  "updated_at" = now()
WHERE (
    "id" = '00000000-0000-4000-8000-000000000004'
    OR "id" IN (
      SELECT "template_id"
      FROM "shop_automations"
      WHERE "type" = 'abandoned_cart' AND "template_id" IS NOT NULL
      UNION
      SELECT s."template_id"
      FROM "shop_automation_steps" s
      JOIN "shop_automations" a ON a."id" = s."automation_id"
      WHERE a."type" = 'abandoned_cart' AND s."template_id" IS NOT NULL
    )
  )
  AND (
    "html" LIKE '%{{tracking_url}}%'
    OR "mjml" LIKE '%{{tracking_url}}%'
    OR "design_json"::text LIKE '%{{tracking_url}}%'
  );

UPDATE "shop_automations"
SET
  "html" = CASE
    WHEN "html" IS NULL THEN NULL
    ELSE replace("html", '{{tracking_url}}', '{{order_url}}')
  END,
  "mjml" = CASE
    WHEN "mjml" IS NULL THEN NULL
    ELSE replace("mjml", '{{tracking_url}}', '{{order_url}}')
  END,
  "design_json" = CASE
    WHEN "design_json" IS NULL THEN NULL
    ELSE replace("design_json"::text, '{{tracking_url}}', '{{order_url}}')::jsonb
  END,
  "updated_at" = now()
WHERE "type" = 'abandoned_cart'
  AND (
    "html" LIKE '%{{tracking_url}}%'
    OR "mjml" LIKE '%{{tracking_url}}%'
    OR "design_json"::text LIKE '%{{tracking_url}}%'
  );

UPDATE "shop_automation_steps" s
SET
  "html" = CASE
    WHEN s."html" IS NULL THEN NULL
    ELSE replace(s."html", '{{tracking_url}}', '{{order_url}}')
  END,
  "mjml" = CASE
    WHEN s."mjml" IS NULL THEN NULL
    ELSE replace(s."mjml", '{{tracking_url}}', '{{order_url}}')
  END,
  "design_json" = CASE
    WHEN s."design_json" IS NULL THEN NULL
    ELSE replace(s."design_json"::text, '{{tracking_url}}', '{{order_url}}')::jsonb
  END,
  "updated_at" = now()
FROM "shop_automations" a
WHERE a."id" = s."automation_id"
  AND a."type" = 'abandoned_cart'
  AND (
    s."html" LIKE '%{{tracking_url}}%'
    OR s."mjml" LIKE '%{{tracking_url}}%'
    OR s."design_json"::text LIKE '%{{tracking_url}}%'
  );
