DROP INDEX IF EXISTS "shop_connections_provider_external_store_id_key";

CREATE UNIQUE INDEX "shop_connections_provider_external_store_id_active_key"
  ON "shop_connections"("provider", "external_store_id")
  WHERE "status" <> 'revoked';

CREATE INDEX IF NOT EXISTS "shop_connections_provider_external_store_id_idx"
  ON "shop_connections"("provider", "external_store_id");
