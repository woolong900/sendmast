-- AlterTable
ALTER TABLE "acs_accounts" ADD COLUMN     "azure_communication_service_name" TEXT;

-- AlterTable
ALTER TABLE "sender_domains" ADD COLUMN     "linked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "sender_usernames" (
    "id" UUID NOT NULL,
    "sender_domain_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT,
    "azure_resource_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_usernames_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sender_usernames_sender_domain_id_idx" ON "sender_usernames"("sender_domain_id");

-- CreateIndex
CREATE UNIQUE INDEX "sender_usernames_sender_domain_id_username_key" ON "sender_usernames"("sender_domain_id", "username");

-- AddForeignKey
ALTER TABLE "sender_usernames" ADD CONSTRAINT "sender_usernames_sender_domain_id_fkey" FOREIGN KEY ("sender_domain_id") REFERENCES "sender_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
