import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { WebhookService, type EventGridEvent } from './webhook.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly svc: WebhookService,
    private readonly config: ConfigService,
  ) {}

  /** Azure Event Grid webhook endpoint. */
  @Post('azure-event-grid')
  @HttpCode(200)
  async azureEventGrid(
    @Body() body: EventGridEvent[] | EventGridEvent,
    @Headers('aeg-event-type') aegEventType: string | undefined,
    @Query('key') key: string | undefined,
  ) {
    this.assertAuthorized(key);
    const events = Array.isArray(body) ? body : [body];
    const result = await this.svc.handleEventGrid(events);
    if (aegEventType === 'SubscriptionValidation' && result.subscriptionValidationResponse) {
      return result.subscriptionValidationResponse;
    }
    return { accepted: result.accepted };
  }

  /**
   * Reject the request unless `?key=` matches EVENTGRID_WEBHOOK_KEY. Without
   * this, anyone could POST forged delivery/bounce/complaint events and skew
   * analytics or trip hard-bounce suppression on real contacts. The handshake
   * (SubscriptionValidation) also carries the key, so validation still passes.
   * When the env var is unset we accept (backward compatible) — set it in prod.
   */
  private assertAuthorized(key: string | undefined): void {
    const expected = this.config.get<string>('EVENTGRID_WEBHOOK_KEY');
    if (!expected) return;
    const given = Buffer.from(key ?? '');
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException('invalid webhook key');
    }
  }
}
