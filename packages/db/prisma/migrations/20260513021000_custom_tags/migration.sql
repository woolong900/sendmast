-- CreateTable
CREATE TABLE "custom_tags" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "values" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_tags_account_id_idx" ON "custom_tags"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_tags_account_id_name_key" ON "custom_tags"("account_id", "name");

-- AddForeignKey
ALTER TABLE "custom_tags" ADD CONSTRAINT "custom_tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
