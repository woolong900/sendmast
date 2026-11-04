-- Storefront (landing-page) behaviour tracking per shop connection.
ALTER TABLE "shop_connections"
  ADD COLUMN "site_tracking_key" TEXT,
  ADD COLUMN "site_tracking_last_seen_at" TIMESTAMP(3),
  ADD COLUMN "site_tracking_install" TEXT,
  ADD COLUMN "site_tracking_script_id" INTEGER;

CREATE UNIQUE INDEX "shop_connections_site_tracking_key_key"
  ON "shop_connections"("site_tracking_key");
