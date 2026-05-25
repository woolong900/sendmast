-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "utm_campaign" TEXT,
ADD COLUMN     "utm_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "utm_medium" TEXT,
ADD COLUMN     "utm_source" TEXT;
