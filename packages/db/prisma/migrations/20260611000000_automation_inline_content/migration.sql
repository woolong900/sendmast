-- Automations now store their email content inline (no longer hard-linked to a
-- template). Add content columns + an optional preheader, and snapshot the same
-- onto each send. Backfill existing rows from their linked template so live
-- flows keep their exact look.

ALTER TABLE "shop_automations"
  ADD COLUMN "html" text,
  ADD COLUMN "mjml" text,
  ADD COLUMN "design_json" jsonb,
  ADD COLUMN "thumbnail" text,
  ADD COLUMN "preheader" text;

ALTER TABLE "shop_automation_steps"
  ADD COLUMN "html" text,
  ADD COLUMN "mjml" text,
  ADD COLUMN "design_json" jsonb,
  ADD COLUMN "thumbnail" text,
  ADD COLUMN "preheader" text;

ALTER TABLE "shop_automation_sends"
  ADD COLUMN "html" text,
  ADD COLUMN "preheader" text;

UPDATE "shop_automations" a
SET "html" = t."html",
    "mjml" = t."mjml",
    "design_json" = t."design_json",
    "thumbnail" = t."thumbnail"
FROM "email_templates" t
WHERE a."template_id" = t."id" AND a."html" IS NULL;

UPDATE "shop_automation_steps" s
SET "html" = t."html",
    "mjml" = t."mjml",
    "design_json" = t."design_json",
    "thumbnail" = t."thumbnail"
FROM "email_templates" t
WHERE s."template_id" = t."id" AND s."html" IS NULL;
