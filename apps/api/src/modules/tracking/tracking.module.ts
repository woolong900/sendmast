import { Module } from '@nestjs/common';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { SiteTrackingController } from './site-tracking.controller';
import { SiteTrackingService } from './site-tracking.service';

@Module({
  controllers: [TrackingController, SiteTrackingController],
  providers: [TrackingService, SiteTrackingService],
  exports: [TrackingService, SiteTrackingService],
})
export class TrackingModule {}

