import { Module } from '@nestjs/common';
import { SegmentController } from './segment.controller';
import { SegmentService } from './segment.service';
import { SegmentRefreshWorker } from './segment-refresh.worker';

@Module({
  controllers: [SegmentController],
  providers: [SegmentService, SegmentRefreshWorker],
  // Exported so CampaignModule can inject SegmentService at send time to
  // turn segmentIds into the matching contactId set.
  exports: [SegmentService],
})
export class SegmentModule {}
