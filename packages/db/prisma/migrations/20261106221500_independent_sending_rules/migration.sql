CREATE TYPE "sending_rule_mode" AS ENUM ('allow', 'block');

CREATE TABLE "sending_rules" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "mode" "sending_rule_mode" NOT NULL,
  "sender_domain_pattern" TEXT NOT NULL,
  "recipient_pattern" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sending_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sending_rules_account_id_mode_sender_domain_pattern_recipient_pattern_key"
  ON "sending_rules"("account_id", "mode", "sender_domain_pattern", "recipient_pattern");
CREATE INDEX "sending_rules_account_id_idx" ON "sending_rules"("account_id");

ALTER TABLE "sending_rules"
  ADD CONSTRAINT "sending_rules_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve rules saved through the short-lived per-domain UI from the
-- previous release by converting each array item into an independent rule.
INSERT INTO "sending_rules" (
  "id", "account_id", "mode", "sender_domain_pattern", "recipient_pattern", "updated_at"
)
SELECT gen_random_uuid(), sd."account_id", 'block', sd."domain", pattern, CURRENT_TIMESTAMP
FROM "sender_domains" sd
CROSS JOIN LATERAL unnest(sd."recipient_block_patterns") AS pattern
ON CONFLICT DO NOTHING;
