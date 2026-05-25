-- Provider trace fields on campaign_recipients.
-- providerResponse keeps the raw ACS body (success or error) for debugging.
ALTER TABLE "campaign_recipients"
  ADD COLUMN "provider_status"     TEXT,
  ADD COLUMN "provider_error_code" TEXT,
  ADD COLUMN "provider_response"   JSONB,
  ADD COLUMN "provider_latency_ms" INTEGER;
