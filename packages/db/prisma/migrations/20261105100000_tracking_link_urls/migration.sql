-- Campaign/automation-scoped click destinations (replaces per-recipient rows).
CREATE TABLE "tracking_link_urls" (
    "id" SERIAL NOT NULL,
    "account_id" UUID NOT NULL,
    "scope_id" UUID NOT NULL,
    "url_hash" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_link_urls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tracking_link_urls_scope_id_url_hash_key" ON "tracking_link_urls"("scope_id", "url_hash");
CREATE INDEX "tracking_link_urls_account_id_idx" ON "tracking_link_urls"("account_id");

ALTER TABLE "tracking_link_urls" ADD CONSTRAINT "tracking_link_urls_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
