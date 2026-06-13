UPDATE "email_templates"
SET "html" = replace("html", 'My Store', '{{shop_name}}'),
    "mjml" = CASE WHEN "mjml" IS NULL THEN NULL ELSE replace("mjml", 'My Store', '{{shop_name}}') END,
    "design_json" = CASE
      WHEN "design_json" IS NULL THEN NULL
      ELSE replace("design_json"::text, 'My Store', '{{shop_name}}')::jsonb
    END,
    "updated_at" = now()
WHERE "scope" = 'system'::"template_scope";

UPDATE "shop_automations"
SET "html" = CASE WHEN "html" IS NULL THEN NULL ELSE replace("html", 'My Store', '{{shop_name}}') END,
    "mjml" = CASE WHEN "mjml" IS NULL THEN NULL ELSE replace("mjml", 'My Store', '{{shop_name}}') END,
    "design_json" = CASE
      WHEN "design_json" IS NULL THEN NULL
      ELSE replace("design_json"::text, 'My Store', '{{shop_name}}')::jsonb
    END,
    "subject" = CASE WHEN "subject" IS NULL THEN NULL ELSE replace("subject", 'My Store', '{{shop_name}}') END,
    "updated_at" = now();

UPDATE "shop_automation_steps"
SET "html" = CASE WHEN "html" IS NULL THEN NULL ELSE replace("html", 'My Store', '{{shop_name}}') END,
    "mjml" = CASE WHEN "mjml" IS NULL THEN NULL ELSE replace("mjml", 'My Store', '{{shop_name}}') END,
    "design_json" = CASE
      WHEN "design_json" IS NULL THEN NULL
      ELSE replace("design_json"::text, 'My Store', '{{shop_name}}')::jsonb
    END,
    "subject" = CASE WHEN "subject" IS NULL THEN NULL ELSE replace("subject", 'My Store', '{{shop_name}}') END,
    "updated_at" = now();
