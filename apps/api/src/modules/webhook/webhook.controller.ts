import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WebhookService, type EventGridEvent } from './webhook.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly svc: WebhookService) {}

  /** Azure Event Grid webhook endpoint. */
  @Post('azure-event-grid')
  @HttpCode(200)
  async azureEventGrid(
    @Body() body: EventGridEvent[] | EventGridEvent,
    @Headers('aeg-event-type') aegEventType: string | undefined,
  ) {
    const events = Array.isArray(body) ? body : [body];
    const result = await this.svc.handleEventGrid(events);
    if (aegEventType === 'SubscriptionValidation' && result.subscriptionValidationResponse) {
      return result.subscriptionValidationResponse;
    }
    return { accepted: result.accepted };
  }
}
