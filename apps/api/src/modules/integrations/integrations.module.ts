import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { ShopWebhookController } from './shop-webhook.controller';
import { IntegrationsService } from './integrations.service';
import { TrackingModule } from '../tracking/tracking.module';

@Module({
  // TrackingModule → SiteTrackingService (storefront script install status).
  imports: [TrackingModule],
  controllers: [IntegrationsController, ShopWebhookController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
