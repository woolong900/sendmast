-- Auto-created "店铺客户" contact list per store connection. Set on bind; the
-- customers/create + order webhooks and the initial full sync add every store
-- customer to this list.

-- AlterTable
ALTER TABLE "shop_connections" ADD COLUMN "customer_list_id" UUID;

-- AddForeignKey
ALTER TABLE "shop_connections" ADD CONSTRAINT "shop_connections_customer_list_id_fkey" FOREIGN KEY ("customer_list_id") REFERENCES "contact_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
