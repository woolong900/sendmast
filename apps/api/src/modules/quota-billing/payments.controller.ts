import { Controller, Logger, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { QuotaBillingService } from './quota-billing.service';

/**
 * Public payment-provider webhooks. NO JwtAuthGuard — Shouqianba calls
 * this server-to-server, but we don't trust the request itself: the
 * notify is treated as a "go look at this order" hint, and the billing
 * service round-trips the gateway's authoritative query API (signed
 * with our terminal_key) to decide whether to credit. See
 * QuotaBillingService.handleShouqianbaNotify for the full rationale.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly svc: QuotaBillingService) {}

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
