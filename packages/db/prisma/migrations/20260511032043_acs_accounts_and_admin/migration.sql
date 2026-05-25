-- CreateEnum
CREATE TYPE "acs_account_status" AS ENUM ('active', 'suspended', 'retired');

-- AlterTable
ALTER TABLE "sender_domains" ADD COLUMN     "acs_account_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_platform_admin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "acs_accounts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "connection_string" TEXT NOT NULL,
    "rps_limit" INTEGER NOT NULL,
    "rpm_limit" INTEGER NOT NULL,
    "rph_limit" INTEGER NOT NULL,
    "rpd_limit" INTEGER NOT NULL,
    "status" "acs_account_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acs_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "sender_domains_acs_account_id_idx" ON "sender_domains"("acs_account_id");

-- AddForeignKey
ALTER TABLE "sender_domains" ADD CONSTRAINT "sender_domains_acs_account_id_fkey" FOREIGN KEY ("acs_account_id") REFERENCES "acs_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
