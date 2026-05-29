-- Server-side thumbnail render status. True while the campaign HTML has changed
-- but worker-thumbnail hasn't produced the new WebP yet; cleared on success.
ALTER TABLE "campaigns" ADD COLUMN "thumbnail_pending" BOOLEAN NOT NULL DEFAULT false;
