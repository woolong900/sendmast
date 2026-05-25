import { Module } from '@nestjs/common';
import { CampaignController } from './campaign.controller';
import { CampaignService } from './campaign.service';
import { TemplateModule } from '../template/template.module';
import { AuthModule } from '../auth/auth.module';
import { SegmentModule } from '../segment/segment.module';

@Module({
  // AuthModule provides AuthService for assertActive() gating; SegmentModule
  // provides SegmentService so send() can resolve segmentIds → contactIds.
  imports: [TemplateModule, AuthModule, SegmentModule],
  controllers: [CampaignController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
