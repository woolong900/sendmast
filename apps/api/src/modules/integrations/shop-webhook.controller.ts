import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import {
  normalizeShopTopic,
  QUEUE_NAMES,
  type ShopEventJob,
} from '@sendmast/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../../common/queue/queue.service';

/**
 * Inbound shopyy webhook receiver. Mirrors the Azure Event Grid controller:
 * authenticate cheaply (per-store `?key=` == ShopConnection.webhookSecret),
 * normalise the topic, enqueue to `shop-events`, and ACK fast. All heavy
 * lifting (contact/order upsert, attribution, automation) happens in
 * worker-shop-sync.
 */
@ApiTags('webhooks')
@Controller('webhooks')
@SkipThrottle()
export class ShopWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Post('shopyy')
  @HttpCode(200)
  async shopyy(
    @Query('store') store: string | undefined,
    @Query('key') key: string | undefined,
    @Query('challenge') challenge: string | undefined,
    @Headers('x-shopyy-topic') topicHeader: string | undefined,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    // Some providers verify a webhook by expecting the challenge echoed back.
    if (challenge) return { challenge };

    if (!store || !key) return { accepted: false };

    const conn = await this.prisma.shopConnection.findUnique({
      where: { provider_externalStoreId: { provider: 'shopyy', externalStoreId: store } },
    });
    // Constant-time compare; silently drop forged/stale calls (no info leak).
    if (
      !conn ||
      conn.status !== 'active' ||
      !conn.webhookSecret ||
      !safeEqual(key, conn.webhookSecret)
    ) {
      return { accepted: false };
    }

    const rawTopic =
      topicHeader ??
      (typeof body?.topic === 'string' ? body.topic : undefined) ??
      (typeof body?.event === 'string' ? body.event : undefined);
    const topic = normalizeShopTopic(rawTopic);
    if (!topic) return { accepted: true, ignored: true };

    const job: ShopEventJob = {
      connectionId: conn.id,
      accountId: conn.accountId,
      topic,
      payload: body ?? {},
      receivedAt: new Date().toISOString(),
    };
    await this.queue.add(QUEUE_NAMES.SHOP_EVENTS, topic, job);
    return { accepted: true };
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
