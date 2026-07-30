ALTER TABLE "tracking_domains"
  ADD COLUMN "last_check_status" VARCHAR(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN "last_check_dns_ok" BOOLEAN,
  ADD COLUMN "last_check_tls_ok" BOOLEAN,
  ADD COLUMN "last_check_caddy_ok" BOOLEAN,
  ADD COLUMN "last_check_http_status" INTEGER,
  ADD COLUMN "last_check_latency_ms" INTEGER,
  ADD COLUMN "last_check_error" TEXT,
  ADD COLUMN "last_checked_at" TIMESTAMP(3),
  ADD COLUMN "consecutive_failures" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "tracking_domains_last_check_status_idx" ON "tracking_domains"("last_check_status");
