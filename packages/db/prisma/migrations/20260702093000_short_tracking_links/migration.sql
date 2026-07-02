CREATE TABLE "tracking_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "recipient_id" UUID,
  "automation_send_id" UUID,
  "link_index" INTEGER NOT NULL,
  "url" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tracking_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tracking_links_exactly_one_source_chk" CHECK (
    ("recipient_id" IS NOT NULL AND "automation_send_id" IS NULL)
    OR ("recipient_id" IS NULL AND "automation_send_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "tracking_links_recipient_id_link_index_key"
  ON "tracking_links"("recipient_id", "link_index");

CREATE UNIQUE INDEX "tracking_links_automation_send_id_link_index_key"
  ON "tracking_links"("automation_send_id", "link_index");

CREATE INDEX "tracking_links_account_id_created_at_idx"
  ON "tracking_links"("account_id", "created_at");

ALTER TABLE "tracking_links"
  ADD CONSTRAINT "tracking_links_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tracking_links"
  ADD CONSTRAINT "tracking_links_automation_send_id_fkey"
  FOREIGN KEY ("automation_send_id") REFERENCES "shop_automation_sends"("id") ON DELETE CASCADE ON UPDATE CASCADE;
