-- DropIndex
DROP INDEX "campaign_segments_segment_id_idx";

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "thumbnail" TEXT;
