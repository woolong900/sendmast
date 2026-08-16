ALTER TABLE "sender_domains"
  ADD COLUMN "cloudflare_zone_id" TEXT,
  ADD COLUMN "cloudflare_subdomain_id" TEXT;

