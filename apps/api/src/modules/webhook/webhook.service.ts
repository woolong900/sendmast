import {
  Injectable,
  Logger,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { QueueService } from '../../common/queue/queue.service';
import { QUEUE_NAMES } from '@sendmast/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { classifyBounce } from './bounce-classifier';

const MAILGUN_SIGNATURE_MAX_AGE_MS = 15 * 60 * 1000;

/** Azure Event Grid event envelope (subset). */
export interface EventGridEvent {
  id: string;
  topic?: string;
  subject?: string;
  eventType: string;
  data: Record<string, unknown>;
  eventTime: string;
  dataVersion?: string;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly queue: QueueService,
    private readonly prisma: PrismaService,
  ) {}

  async handleEventGrid(events: EventGridEvent[]): Promise<{
    accepted: number;
    subscriptionValidationResponse?: { validationResponse: string };
  }> {
    let validationResponse: string | undefined;
    let accepted = 0;

    for (const ev of events) {
      // Subscription validation handshake
      if (ev.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
        const code = (ev.data as { validationCode?: string }).validationCode;
        if (code) validationResponse = code;
        continue;
      }

      const ourType = mapEmailChannelEvent(ev);
      if (!ourType) {
        this.logger.warn(`Unknown event type: ${ev.eventType}`);
        continue;
      }

      const data = ev.data as Record<string, unknown>;
      // ACS includes recipient + messageId in the data payload
      const recipientHeader = (data.recipient ?? data.recipientAddress) as string | undefined;
      const messageId = (data.messageId ?? data.id) as string | undefined;
      const ourRecipientId = (data.internalMessageId ??
        (data as { headers?: Record<string, string> }).headers?.['X-SendMast-Recipient']) as
        | string
        | undefined;

      // Bounce kind is computed at webhook time so worker-events doesn't have
      // to re-parse the payload. Stored as '' for non-bounce events.
      const bounceKind = ourType === 'bounce' ? classifyBounce(data) : '';

      await this.queue.add(QUEUE_NAMES.EVENTS_INGEST, 'event', {
        kind: ourType,
        recipientId: ourRecipientId, // resolver in worker can fall back via messageId
        externalRecipient: recipientHeader,
        messageId,
        receivedAt: Date.now(),
        rawMeta: data,
        bounceKind,
      });
      accepted += 1;
    }

    return validationResponse
      ? { accepted, subscriptionValidationResponse: { validationResponse } }
      : { accepted };
  }

  async handleMailgun(body: unknown): Promise<{ accepted: number }> {
    const payload = body as MailgunWebhookPayload;
    const signature = payload?.signature;
    const eventData = payload?.['event-data'];
    if (!signature?.timestamp || !signature?.token || !signature?.signature || !eventData) {
      throw new UnauthorizedException('invalid Mailgun webhook payload');
    }

    await this.assertMailgunSignature(signature);

    const mapped = mapMailgunEvent(eventData);
    if (!mapped) {
      this.logger.warn(`Unknown Mailgun event: ${String(eventData.event ?? '')}`);
      return { accepted: 0 };
    }

    const vars = normaliseVariables(eventData['user-variables']);
    const messageId =
      vars.sendmast_operation_id ??
      stringValue(eventData.message?.headers?.['message-id']) ??
      stringValue(eventData.message?.headers?.['Message-Id']) ??
      stringValue(eventData.id);

    await this.queue.add(QUEUE_NAMES.EVENTS_INGEST, 'event', {
      kind: mapped.kind,
      recipientId: vars.sendmast_recipient_id,
      source: vars.sendmast_source === 'a' ? 'a' : undefined,
      externalRecipient: stringValue(eventData.recipient),
      messageId,
      linkUrl: mapped.kind === 'c' ? stringValue(eventData.url) : undefined,
      ip: stringValue(eventData['client-info']?.['client-ip']),
      userAgent: stringValue(eventData['client-info']?.['user-agent']),
      receivedAt: eventTimestampMs(eventData.timestamp),
      rawMeta: eventData as Record<string, unknown>,
      bounceKind: mapped.bounceKind,
    });

    return { accepted: 1 };
  }

  private async assertMailgunSignature(signature: MailgunSignature): Promise<void> {
    const timestampMs = Number(signature.timestamp) * 1000;
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > MAILGUN_SIGNATURE_MAX_AGE_MS
    ) {
      throw new UnauthorizedException('stale Mailgun webhook signature');
    }

    const keys = await this.prisma.emailChannel.findMany({
      where: {
        provider: 'mailgun',
        mailgunWebhookSigningKey: { not: null },
      },
      select: { mailgunWebhookSigningKey: true },
    });
    if (keys.length === 0) {
      throw new ServiceUnavailableException('Mailgun webhook signing key is not configured');
    }

    const signed = `${signature.timestamp}${signature.token}`;
    const incoming = Buffer.from(signature.signature, 'hex');
    const ok = keys.some((row) => {
      const key = row.mailgunWebhookSigningKey;
      if (!key) return false;
      const expected = Buffer.from(createHmac('sha256', key).update(signed).digest('hex'), 'hex');
      return incoming.length === expected.length && timingSafeEqual(incoming, expected);
    });
    if (!ok) throw new UnauthorizedException('invalid Mailgun webhook signature');
  }
}

interface MailgunSignature {
  timestamp: string;
  token: string;
  signature: string;
}

interface MailgunWebhookPayload {
  signature?: MailgunSignature;
  'event-data'?: MailgunEventData;
}

interface MailgunEventData {
  event?: unknown;
  id?: unknown;
  timestamp?: unknown;
  severity?: unknown;
  reason?: unknown;
  recipient?: unknown;
  url?: unknown;
  message?: { headers?: Record<string, unknown> };
  'user-variables'?: unknown;
  'client-info'?: Record<string, unknown>;
}

function mapMailgunEvent(data: MailgunEventData): {
  kind: 'delivered' | 'bounce' | 'complaint' | 'o' | 'c' | 'u' | 'failed';
  bounceKind?: 'hard' | 'soft' | '';
} | null {
  const event = String(data.event ?? '').toLowerCase();
  if (event === 'delivered') return { kind: 'delivered' };
  if (event === 'opened') return { kind: 'o' };
  if (event === 'clicked') return { kind: 'c' };
  if (event === 'unsubscribed') return { kind: 'u' };
  if (event === 'complained') return { kind: 'complaint' };
  if (event === 'failed') {
    return {
      kind: 'bounce',
      bounceKind: String(data.severity ?? '').toLowerCase() === 'permanent' ? 'hard' : 'soft',
    };
  }
  if (event === 'rejected') return { kind: 'failed' };
  return null;
}

function normaliseVariables(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[key.replace(/-/g, '_')] = String(v);
  }
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function eventTimestampMs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) : Date.now();
}

function mapEmailChannelEvent(
  ev: EventGridEvent,
): 'delivered' | 'bounce' | 'complaint' | 'failed' | null {
  if (ev.eventType === 'Microsoft.Communication.EmailDeliveryReportReceived') {
    const status = String((ev.data as { status?: string }).status ?? '').toLowerCase();
    if (status === 'delivered') return 'delivered';
    if (status === 'bounced' || status === 'bounce' || status === 'failed') return 'bounce';
    if (status === 'suppressed') return 'failed';
    return 'failed';
  }
  // ACS only emits the delivery report event type we handle above. Any other
  // event type (engagement opens/clicks come from our tracking pixel/redirect,
  // not Event Grid) is ignored.
  return null;
}
