-- Tracking domain pool. See `model TrackingDomain` in schema.prisma for the
-- product rationale (spread spam risk across hostnames instead of using the
-- primary app domain for open/click/unsubscribe URLs).

CREATE TABLE "tracking_domains" (
    "id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tracking_domains_domain_key" ON "tracking_domains"("domain");
CREATE INDEX "tracking_domains_status_idx" ON "tracking_domains"("status");
