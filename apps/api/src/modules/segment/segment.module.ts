import { Module } from '@nestjs/common';
import { SegmentController } from './segment.controller';
import { SegmentService } from './segment.service';

@Module({
  controllers: [SegmentController],
  providers: [SegmentService],
  // Exported so CampaignModule can inject SegmentService at send time to
  // turn segmentIds into the matching contactId set.
  exports: [SegmentService],
})
export class SegmentModule {}
