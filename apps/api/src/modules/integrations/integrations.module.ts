import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { ShopWebhookController } from './shop-webhook.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  controllers: [IntegrationsController, ShopWebhookController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
