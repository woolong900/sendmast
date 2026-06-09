-- Shopyy (OEMSAAS) e-commerce integration.
--
-- A tenant connects an external store (shop_connections) via an OAuth-like
-- authorize exchange; we ingest orders (shop_orders) and abandoned checkouts
-- (shop_abandoned_checkouts), attribute revenue to email campaigns, and run
-- three buyer-facing automations (shop_automations) with an idempotency ledger
-- (shop_automation_sends).

-- CreateEnum
CREATE TYPE "shop_provider" AS ENUM ('shopyy');
CREATE TYPE "shop_connection_status" AS ENUM ('active', 'expired', 'revoked');
CREATE TYPE "shop_automation_type" AS ENUM ('order_paid', 'order_shipped', 'abandoned_cart');

-- CreateTable shop_connections
CREATE TABLE "shop_connections" (
    "id"                UUID                     NOT NULL DEFAULT gen_random_uuid(),
    "account_id"        UUID                     NOT NULL,
    "provider"          "shop_provider"          NOT NULL DEFAULT 'shopyy',
    "external_store_id" TEXT                     NOT NULL,
    "shop_name"         TEXT,
    "shop_domain"       TEXT,
    "main_domain"       TEXT,
    "brand_id"          TEXT,
    "time_zone"         TEXT,
    "openapi_domain"    TEXT                     NOT NULL,
    "webhook_baseurl"   TEXT,
    "app_external_id"   TEXT,
    "app_key"           TEXT,
    "app_name"          TEXT,
    "dev_token"         TEXT                     NOT NULL,
    "webhook_secret"    TEXT,
    "status"            "shop_connection_status" NOT NULL DEFAULT 'active',
    "store_expired_at"  TIMESTAMP(3),
    "connected_at"      TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sync_at"      TIMESTAMP(3),
    "created_at"        TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3)             NOT NULL,
    CONSTRAINT "shop_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_connections_provider_external_store_id_key"
    ON "shop_connections"("provider", "external_store_id");
CREATE INDEX "shop_connections_account_id_idx"
    ON "shop_connections"("account_id");

ALTER TABLE "shop_connections"
    ADD CONSTRAINT "shop_connections_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable shop_orders
CREATE TABLE "shop_orders" (
    "id"                     UUID          NOT NULL DEFAULT gen_random_uuid(),
    "account_id"             UUID          NOT NULL,
    "shop_connection_id"     UUID          NOT NULL,
    "external_order_id"      TEXT          NOT NULL,
    "order_no"               TEXT,
    "customer_email"         TEXT          NOT NULL,
    "contact_id"             UUID,
    "value"                  NUMERIC(18,2) NOT NULL,
    "currency"               TEXT          NOT NULL,
    "status"                 TEXT          NOT NULL,
    "order_time"             TIMESTAMP(3)  NOT NULL,
    "attributed_campaign_id" UUID,
    "attributed_contact_id"  UUID,
    "attribution_model"      TEXT,
    "raw"                    JSONB,
    "created_at"             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3)  NOT NULL,
    CONSTRAINT "shop_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_orders_shop_connection_id_external_order_id_key"
    ON "shop_orders"("shop_connection_id", "external_order_id");
CREATE INDEX "shop_orders_account_id_order_time_idx"
    ON "shop_orders"("account_id", "order_time");
CREATE INDEX "shop_orders_attributed_campaign_id_idx"
    ON "shop_orders"("attributed_campaign_id");
CREATE INDEX "shop_orders_customer_email_idx"
    ON "shop_orders"("customer_email");

ALTER TABLE "shop_orders"
    ADD CONSTRAINT "shop_orders_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_orders"
    ADD CONSTRAINT "shop_orders_shop_connection_id_fkey"
    FOREIGN KEY ("shop_connection_id") REFERENCES "shop_connections"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable shop_automations
CREATE TABLE "shop_automations" (
    "id"                 UUID                   NOT NULL DEFAULT gen_random_uuid(),
    "account_id"         UUID                   NOT NULL,
    "shop_connection_id" UUID                   NOT NULL,
    "type"               "shop_automation_type" NOT NULL,
    "enabled"            BOOLEAN                NOT NULL DEFAULT false,
    "template_id"        UUID,
    "sender_domain_id"   UUID,
    "from_email"         TEXT,
    "from_name"          TEXT,
    "subject"            TEXT,
    "delay_minutes"      INTEGER                NOT NULL DEFAULT 60,
    "system_campaign_id" UUID,
    "created_at"         TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3)           NOT NULL,
    CONSTRAINT "shop_automations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_automations_shop_connection_id_type_key"
    ON "shop_automations"("shop_connection_id", "type");
CREATE INDEX "shop_automations_account_id_idx"
    ON "shop_automations"("account_id");

ALTER TABLE "shop_automations"
    ADD CONSTRAINT "shop_automations_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_automations"
    ADD CONSTRAINT "shop_automations_shop_connection_id_fkey"
    FOREIGN KEY ("shop_connection_id") REFERENCES "shop_connections"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable shop_automation_sends
CREATE TABLE "shop_automation_sends" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "account_id"    UUID         NOT NULL,
    "automation_id" UUID         NOT NULL,
    "dedup_key"     TEXT         NOT NULL,
    "email"         TEXT         NOT NULL,
    "contact_id"    UUID,
    "status"        TEXT         NOT NULL DEFAULT 'sent',
    "recipient_id"  UUID,
    "error_message" TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shop_automation_sends_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_automation_sends_automation_id_dedup_key_key"
    ON "shop_automation_sends"("automation_id", "dedup_key");
CREATE INDEX "shop_automation_sends_account_id_created_at_idx"
    ON "shop_automation_sends"("account_id", "created_at");

ALTER TABLE "shop_automation_sends"
    ADD CONSTRAINT "shop_automation_sends_automation_id_fkey"
    FOREIGN KEY ("automation_id") REFERENCES "shop_automations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable shop_abandoned_checkouts
CREATE TABLE "shop_abandoned_checkouts" (
    "id"                     UUID          NOT NULL DEFAULT gen_random_uuid(),
    "account_id"             UUID          NOT NULL,
    "shop_connection_id"     UUID          NOT NULL,
    "external_checkout_id"   TEXT          NOT NULL,
    "customer_email"         TEXT          NOT NULL,
    "contact_id"             UUID,
    "value"                  NUMERIC(18,2),
    "currency"               TEXT,
    "recovery_url"           TEXT,
    "abandoned_at"           TIMESTAMP(3)  NOT NULL,
    "recovered_at"           TIMESTAMP(3),
    "recovery_email_sent_at" TIMESTAMP(3),
    "status"                 TEXT          NOT NULL DEFAULT 'pending',
    "raw"                    JSONB,
    "created_at"             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3)  NOT NULL,
    CONSTRAINT "shop_abandoned_checkouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_abandoned_checkouts_shop_connection_id_external_checko_key"
    ON "shop_abandoned_checkouts"("shop_connection_id", "external_checkout_id");
CREATE INDEX "shop_abandoned_checkouts_account_id_abandoned_at_idx"
    ON "shop_abandoned_checkouts"("account_id", "abandoned_at");

ALTER TABLE "shop_abandoned_checkouts"
    ADD CONSTRAINT "shop_abandoned_checkouts_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_abandoned_checkouts"
    ADD CONSTRAINT "shop_abandoned_checkouts_shop_connection_id_fkey"
    FOREIGN KEY ("shop_connection_id") REFERENCES "shop_connections"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
