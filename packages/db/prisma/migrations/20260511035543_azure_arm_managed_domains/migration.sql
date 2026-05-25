/*
  Warnings:

  - You are about to drop the column `dkim_private_key` on the `sender_domains` table. All the data in the column will be lost.
  - You are about to drop the column `dkim_public_key` on the `sender_domains` table. All the data in the column will be lost.
  - You are about to drop the column `dkim_selector` on the `sender_domains` table. All the data in the column will be lost.
  - You are about to drop the column `dmarc_record` on the `sender_domains` table. All the data in the column will be lost.
  - You are about to drop the column `spf_record` on the `sender_domains` table. All the data in the column will be lost.
  - Added the required column `azure_client_id` to the `acs_accounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `azure_client_secret` to the `acs_accounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `azure_email_service_name` to the `acs_accounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `azure_resource_group` to the `acs_accounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `azure_subscription_id` to the `acs_accounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `azure_tenant_id` to the `acs_accounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `verification_records` to the `sender_domains` table without a default value. This is not possible if the table is not empty.
  - Made the column `acs_account_id` on table `sender_domains` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "sender_domains" DROP CONSTRAINT "sender_domains_acs_account_id_fkey";

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "default_acs_account_id" UUID;

-- AlterTable
ALTER TABLE "acs_accounts" ADD COLUMN     "azure_client_id" TEXT NOT NULL,
ADD COLUMN     "azure_client_secret" TEXT NOT NULL,
ADD COLUMN     "azure_email_service_name" TEXT NOT NULL,
ADD COLUMN     "azure_resource_group" TEXT NOT NULL,
ADD COLUMN     "azure_subscription_id" TEXT NOT NULL,
ADD COLUMN     "azure_tenant_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "sender_domains" DROP COLUMN "dkim_private_key",
DROP COLUMN "dkim_public_key",
DROP COLUMN "dkim_selector",
DROP COLUMN "dmarc_record",
DROP COLUMN "spf_record",
ADD COLUMN     "verification_records" JSONB NOT NULL,
ADD COLUMN     "verification_states" JSONB,
ALTER COLUMN "acs_account_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "accounts_default_acs_account_id_idx" ON "accounts"("default_acs_account_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_default_acs_account_id_fkey" FOREIGN KEY ("default_acs_account_id") REFERENCES "acs_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_domains" ADD CONSTRAINT "sender_domains_acs_account_id_fkey" FOREIGN KEY ("acs_account_id") REFERENCES "acs_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
