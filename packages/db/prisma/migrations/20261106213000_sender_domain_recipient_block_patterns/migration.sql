ALTER TABLE "sender_domains"
ADD COLUMN "recipient_block_patterns" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
