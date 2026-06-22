import { Controller, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AirwallexService } from './airwallex.service';
import { QuotaBillingService } from './quota-billing.service';

/**
 * Public payment-provider webhooks. NO JwtAuthGuard because providers call
 * these endpoints server-to-server. Airwallex requests are HMAC-verified;
 * the legacy Shouqianba callback is confirmed through its order query API.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly svc: QuotaBillingService,
    private readonly airwallex: AirwallexService,
  ) {}

  @Post('airwallex/webhook')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async airwallexWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const timestamp = String(req.headers['x-timestamp'] ?? '');
    const signature = String(req.headers['x-signature'] ?? '');
    if (!rawBody || !this.airwallex.verifyWebhook(rawBody, timestamp, signature)) {
      this.logger.warn('Airwallex webhook: invalid signature');
      res.status(400).type('text/plain').send('invalid signature');
      return;
    }

    try {
      await this.svc.handleAirwallexWebhook(rawBody);
      res.status(200).send();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Airwallex webhook processing failed: ${msg}`);
      res.status(500).type('text/plain').send('processing failed');
    }
  }

  /**
   * Shouqianba async notify. Shouqianba retries until we literally write
   * the bytes `success` (lowercase, no JSON, no newline) — any other
   * response counts as failure and triggers another retry. We tolerate
   * the retry storm but cap at 240/min/IP via @Throttle so a runaway
   * webhook (or attacker) can't DoS the endpoint.
   */
  @Post('shouqianba/notify')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async shouqianbaNotify(
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    if (!rawBody) {
      this.logger.warn('Shouqianba notify: empty body');
      res.type('text/plain').send('failure');
      return;
    }
    const result = await this.svc.handleShouqianbaNotify(rawBody);
    res.type('text/plain').send(result);
  }
}
