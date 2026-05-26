-- Referral / commission. See models ReferralChannel, CommissionRecord,
-- ReferralSetting in schema.prisma for the product rationale (admin
-- creates partner channels, /signup?ref=<code> attributes the new tenant,
-- every paid QuotaOrder spawns a CommissionRecord at the current global
-- rate, settlement is off-platform via per-month CSV export).

CREATE TABLE "referral_channels" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "payout_info" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_channels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "referral_channels_code_key" ON "referral_channels"("code");

-- Attribution columns on accounts. Nullable so existing tenants stay
-- untouched; SetNull on channel delete so a channel can be removed
-- without orphaning historical accounts.
ALTER TABLE "accounts"
    ADD COLUMN "referred_by_channel_id" UUID,
    ADD COLUMN "referred_at" TIMESTAMP(3);
CREATE INDEX "accounts_referred_by_channel_id_idx" ON "accounts"("referred_by_channel_id");
ALTER TABLE "accounts"
    ADD CONSTRAINT "accounts_referred_by_channel_id_fkey"
    FOREIGN KEY ("referred_by_channel_id") REFERENCES "referral_channels"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Commission ledger. order_id is UNIQUE so the create runs exactly once
-- even if the Shouqianba notify is retried after we already credited the
-- order. (We don't FK to quota_orders so a future archival of old orders
-- doesn't break commission rows; quota_orders.id is UUID and unique
-- on its own already.)
CREATE TABLE "commission_records" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "order_amount_cny" DECIMAL(10,2) NOT NULL,
    "rate_percent" DECIMAL(5,2) NOT NULL,
    "commission_cny" DECIMAL(10,2) NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "commission_records_order_id_key" ON "commission_records"("order_id");
CREATE INDEX "commission_records_channel_id_paid_at_idx" ON "commission_records"("channel_id", "paid_at");
CREATE INDEX "commission_records_paid_at_idx" ON "commission_records"("paid_at");

ALTER TABLE "commission_records"
    ADD CONSTRAINT "commission_records_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "referral_channels"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_records"
    ADD CONSTRAINT "commission_records_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Singleton settings row. Seeded with the default 15% so the commission
-- hook never has to special-case "no row exists yet".
CREATE TABLE "referral_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "rate_percent" DECIMAL(5,2) NOT NULL DEFAULT 15.00,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_settings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "referral_settings" ("id", "rate_percent", "updated_at")
VALUES ('singleton', 15.00, CURRENT_TIMESTAMP);
