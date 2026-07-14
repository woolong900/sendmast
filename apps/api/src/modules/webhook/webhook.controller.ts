import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { WebhookService, type EventGridEvent } from './webhook.service';

@ApiTags('webhooks')
@Controller('webhooks')
// Azure Event Grid delivers delivery/bounce reports in high-volume bursts from
// a pool of Azure IPs; the global 240/min per-IP throttle would 429 (and drop)
// legitimate reports during a large send. This endpoint is authenticated by the
// shared secret header, so it's safe to exempt from IP rate limiting.
@SkipThrottle()
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
    @Headers('authorization') authorization: string | undefined,
  ) {
    this.assertAuthorized(bearerToken(authorization));
    const events = Array.isArray(body) ? body : [body];
    const result = await this.svc.handleEventGrid(events);
    if (aegEventType === 'SubscriptionValidation' && result.subscriptionValidationResponse) {
      return result.subscriptionValidationResponse;
    }
    return { accepted: result.accepted };
  }

  /** Mailgun webhook endpoint. Configure this URL in Mailgun as /api/webhooks/mailgun. */
  @Post('mailgun')
  @HttpCode(200)
  async mailgun(@Body() body: unknown) {
    return this.svc.handleMailgun(body);
  }

  /** Resend webhook endpoint. Configure this URL in Resend as /api/webhooks/resend. */
  @Post('resend')
  @HttpCode(200)
  async resend(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('svix-id') svixId: string | undefined,
    @Headers('svix-timestamp') svixTimestamp: string | undefined,
    @Headers('svix-signature') svixSignature: string | undefined,
  ) {
    return this.svc.handleResend(req.rawBody?.toString('utf8') ?? '', {
      id: svixId,
      timestamp: svixTimestamp,
      signature: svixSignature,
    });
  }

  /**
   * Reject the request unless the shared key matches EVENTGRID_WEBHOOK_KEY.
   * The Authorization header is used because Caddy redacts it from access logs.
   */
  private assertAuthorized(key: string | undefined): void {
    const expected = this.config.get<string>('EVENTGRID_WEBHOOK_KEY');
    if (!expected) {
      throw new ServiceUnavailableException('webhook authentication is not configured');
    }
    const given = Buffer.from(key ?? '');
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException('invalid webhook key');
    }
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
