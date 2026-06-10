-- Multi-round abandoned-cart recovery: each round (up to 5) carries its own
-- template / subject / absolute delay. Sends snapshot the round's template.

-- CreateTable
CREATE TABLE "shop_automation_steps" (
    "id" UUID NOT NULL,
    "automation_id" UUID NOT NULL,
    "step_index" INTEGER NOT NULL,
    "template_id" UUID,
    "subject" TEXT,
    "delay_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_automation_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_automation_steps_automation_id_step_index_key" ON "shop_automation_steps"("automation_id", "step_index");

-- AddForeignKey
ALTER TABLE "shop_automation_steps" ADD CONSTRAINT "shop_automation_steps_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "shop_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: snapshot which template a send rendered (per-round abandoned cart).
ALTER TABLE "shop_automation_sends" ADD COLUMN "template_id" UUID;

-- Backfill round 1 from each existing abandoned_cart automation's config so
-- already-configured stores keep working unchanged.
INSERT INTO "shop_automation_steps" ("id", "automation_id", "step_index", "template_id", "subject", "delay_minutes", "created_at", "updated_at")
SELECT gen_random_uuid(), a."id", 1, a."template_id", a."subject", a."delay_minutes", now(), now()
FROM "shop_automations" a
WHERE a."type" = 'abandoned_cart'
  AND NOT EXISTS (SELECT 1 FROM "shop_automation_steps" s WHERE s."automation_id" = a."id");
