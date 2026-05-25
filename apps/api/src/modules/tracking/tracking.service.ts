import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyTrackingToken, type TrackingPayload } from '@sendmast/email-tracking';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../../common/queue/queue.service';
import { QUEUE_NAMES } from '@sendmast/shared';

export interface TrackEventInput {
  payload: TrackingPayload;
  ip?: string;
  userAgent?: string;
  linkUrl?: string;
  /** Free-form reason captured on the unsubscribe confirmation page. */
  reason?: string;
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly config: ConfigService,
  ) {}

  verify(token: string): TrackingPayload | null {
    const secret = this.config.getOrThrow<string>('TRACKING_TOKEN_SECRET');
    return verifyTrackingToken(token, secret);
  }

  async record(input: TrackEventInput): Promise<void> {
    // We stuff the unsubscribe reason into rawMeta so it ends up in
    // ClickHouse email_events.raw_meta — same place ACS bounce reasons live.
    // The recipients API parses it back out for the 退订原因 column.
    const rawMeta =
      input.reason && input.reason.trim().length > 0
        ? { reason: input.reason.trim() }
        : undefined;
    await this.queue.add(QUEUE_NAMES.EVENTS_INGEST, 'event', {
      kind: input.payload.k,
      recipientId: input.payload.r,
      linkIndex: input.payload.i,
      linkUrl: input.linkUrl,
      ip: input.ip,
      userAgent: input.userAgent,
      receivedAt: Date.now(),
      rawMeta,
    });
  }

  async resolveRecipient(recipientId: string) {
    return this.prisma.campaignRecipient.findUnique({
      where: { id: recipientId },
      include: { campaign: true },
    });
  }

  async unsubscribeByToken(
    payload: TrackingPayload,
    reason?: string,
  ): Promise<{ ok: boolean; email?: string }> {
    if (payload.k !== 'u') return { ok: false };
    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { id: payload.r },
      include: { campaign: true },
    });
    if (!recipient) return { ok: false };

    const accountId = recipient.accountId;
    const email = recipient.email;

    await this.prisma.$transaction([
      this.prisma.contact.updateMany({
        where: { accountId, email },
        data: { subscriptionStatus: 'unsubscribed', unsubscribedAt: new Date() },
      }),
      this.prisma.suppressionEntry.upsert({
        where: { accountId_email: { accountId, email } },
        update: { reason: 'unsubscribe' },
        create: { accountId, email, reason: 'unsubscribe' },
      }),
    ]);

    await this.record({ payload, reason });
    return { ok: true, email };
  }
}
