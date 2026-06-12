UPDATE "email_templates"
SET "html" = replace(
  "html",
  '/assets/automation-welcome-banner-v1.jpg',
  '/assets/automation-welcome-banner-v2.jpg'
),
"updated_at" = now()
WHERE "html" LIKE '%/assets/automation-welcome-banner-v1.jpg%';

UPDATE "shop_automations"
SET "html" = replace(
  "html",
  '/assets/automation-welcome-banner-v1.jpg',
  '/assets/automation-welcome-banner-v2.jpg'
),
"updated_at" = now()
WHERE "html" LIKE '%/assets/automation-welcome-banner-v1.jpg%';
