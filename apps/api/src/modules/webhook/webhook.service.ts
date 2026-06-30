import { Injectable, Logger, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { QueueService } from '../../common/queue/queue.service';
import { QUEUE_NAMES } from '@sendmast/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

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

  async handleEventGrid(events: EventGridEvent[]): Promise<{ accepted: number; subscriptionValidationResponse?: { validationResponse: string } }> {
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
        (data as { headers?: Record<string, string> }).headers?.['X-SendMast-Recipient']) as string | undefined;

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
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAILGUN_SIGNATURE_MAX_AGE_MS) {
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

function mapMailgunEvent(
  data: MailgunEventData,
): { kind: 'delivered' | 'bounce' | 'complaint' | 'o' | 'c' | 'u' | 'failed'; bounceKind?: 'hard' | 'soft' | '' } | null {
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

/**
 * Phrases (and enhanced status codes) that confidently mean "the RECIPIENT
 * mailbox itself is unusable" — i.e. a real 无效邮箱 we should suppress. Matched
 * case-insensitively as plain substrings against the failure message.
 *
 * Deliberately narrow. A bare 5xx is NOT enough: most of our 5xx bounces are
 * sender-side policy / reputation / DNS blocks (e.g. Gmail 550-5.7.1 "low
 * reputation of the sending domain", "Sender verify failed", "no A/AAAA/MX
 * records"), where the recipient address is perfectly fine. Treating those as
 * hard would suppress good contacts over OUR deliverability problem.
 */
const HARD_BOUNCE_SIGNALS = [
  '5.1.1', // enhanced status: bad destination mailbox (no such user)
  '5.1.10', // null MX / recipient does not exist (Office365)
  'does not exist',
  'user unknown',
  'unknown user',
  'no such user',
  'no such recipient',
  'no such mailbox',
  'user not found',
  'mailbox not found',
  'address not found',
  'invalid recipient',
  'unknown recipient',
  'recipient unknown',
  'recipient address rejected', // Exchange/O365 550 5.1.1 RecipNotFound (real bad address)
  // NOTE: bare "recipient rejected" is intentionally NOT here. Charter/Spectrum
  // (*.rr.com, charter.net, roadrunner.com, twc.com, bresnan.net) emit
  // "<addr> recipient rejected};{MSG=};{FQDN=...charter.net};{IP=...}" with NO
  // SMTP/enhanced code as an IP/reputation block, not a bad-mailbox signal.
  // Treating it as hard would suppress good contacts over our deliverability.
  'not a valid user', // e.g. "x@y is not a valid user"
  'mailbox is disabled', // Yahoo 554.30 — account deactivated
  'account is disabled',
  'is inactive', // Gmail 5.2.1 — "account that you tried to reach is inactive"
];

/**
 * Phrases that mean the failure is about OUR sending side (the sender domain /
 * MAIL FROM / reputation), NOT the recipient mailbox. These take priority over
 * HARD_BOUNCE_SIGNALS because some sender-side rejections reuse mailbox wording,
 * e.g. "Domain of sender address postal@… does not exist" or "Sender verify
 * failed" — there "does not exist" refers to our domain, not the recipient.
 */
const SENDER_SIDE_SIGNALS = ['sender', 'mail from', 'reputation'];

/**
 * Classify a bounce as a permanent recipient failure ('hard') vs. anything else
 * ('soft').
 *
 *   1. Any sender-side signal (it's our domain/reputation problem) → 'soft'.
 *   2. Otherwise a HARD_BOUNCE_SIGNAL (recipient mailbox unusable) → 'hard'.
 *   3. Otherwise (transient 4xx, code-less, policy blocks) → 'soft'.
 *
 * We default to soft so we never over-suppress a good recipient over our own
 * deliverability problem. Only 'hard' drives suppression downstream
 * (worker-events).
 *
 * Source: data.deliveryStatusDetails.statusMessage — free-form, often
 * "550 5.1.1 user unknown" or "550 5.7.1 ... message blocked".
 */
function classifyBounce(data: Record<string, unknown>): 'hard' | 'soft' {
  const msg = String(
    (data as { deliveryStatusDetails?: { statusMessage?: string } })
      .deliveryStatusDetails?.statusMessage ?? '',
  ).toLowerCase();
  if (SENDER_SIDE_SIGNALS.some((s) => msg.includes(s))) return 'soft';
  return HARD_BOUNCE_SIGNALS.some((s) => msg.includes(s)) ? 'hard' : 'soft';
}

function mapEmailChannelEvent(ev: EventGridEvent): 'delivered' | 'bounce' | 'complaint' | 'failed' | null {
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
