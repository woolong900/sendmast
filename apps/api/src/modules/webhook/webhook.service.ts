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
const RESEND_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

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

  async handleResend(
    rawBody: string,
    headers: ResendSignatureHeaders,
  ): Promise<{ accepted: number }> {
    if (!rawBody || !headers.id || !headers.timestamp || !headers.signature) {
      throw new UnauthorizedException('invalid Resend webhook payload');
    }

    await this.assertResendSignature(rawBody, headers);

    const payload = parseJsonObject(rawBody) as ResendWebhookPayload;
    const mapped = mapResendEvent(payload);
    if (!mapped) {
      this.logger.warn(`Unknown Resend event: ${String(payload.type ?? '')}`);
      return { accepted: 0 };
    }

    const data = payload.data ?? {};
    const tags = normaliseVariables(data.tags);
    const messageId =
      tags.sendmast_operation_id ??
      stringValue(data.email_id) ??
      stringValue(data.message_id);

    await this.queue.add(QUEUE_NAMES.EVENTS_INGEST, 'event', {
      kind: mapped.kind,
      recipientId: tags.sendmast_recipient_id,
      source: tags.sendmast_source === 'a' ? 'a' : undefined,
      externalRecipient: firstString(data.to),
      messageId,
      linkUrl: mapped.kind === 'c' ? stringValue(data.click?.link) : undefined,
      ip:
        mapped.kind === 'c'
          ? stringValue(data.click?.ipAddress)
          : mapped.kind === 'o'
            ? stringValue(data.open?.ipAddress)
            : undefined,
      userAgent:
        mapped.kind === 'c'
          ? stringValue(data.click?.userAgent)
          : mapped.kind === 'o'
            ? stringValue(data.open?.userAgent)
            : undefined,
      receivedAt: isoTimestampMs(payload.created_at) ?? isoTimestampMs(data.created_at) ?? Date.now(),
      rawMeta: payload as Record<string, unknown>,
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

  private async assertResendSignature(
    payload: string,
    headers: ResendSignatureHeaders,
  ): Promise<void> {
    const timestampMs = Number(headers.timestamp) * 1000;
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > RESEND_SIGNATURE_MAX_AGE_MS
    ) {
      throw new UnauthorizedException('stale Resend webhook signature');
    }

    const keys = await this.prisma.emailChannel.findMany({
      where: {
        provider: 'resend',
        resendWebhookSigningKey: { not: null },
      },
      select: { resendWebhookSigningKey: true },
    });
    if (keys.length === 0) {
      throw new ServiceUnavailableException('Resend webhook signing key is not configured');
    }

    const signed = `${headers.id}.${headers.timestamp}.${payload}`;
    const signatures = parseSvixSignatures(headers.signature ?? '');
    const ok = keys.some((row) => {
      const key = row.resendWebhookSigningKey;
      if (!key) return false;
      const expected = createSvixSignature(key, signed);
      return signatures.some((incoming) =>
        incoming.length === expected.length && timingSafeEqual(incoming, expected),
      );
    });
    if (!ok) throw new UnauthorizedException('invalid Resend webhook signature');
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

interface ResendSignatureHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

interface ResendWebhookPayload {
  type?: unknown;
  created_at?: unknown;
  data?: ResendWebhookData;
}

interface ResendWebhookData {
  created_at?: unknown;
  email_id?: unknown;
  message_id?: unknown;
  to?: unknown;
  tags?: unknown;
  bounce?: {
    type?: unknown;
    subType?: unknown;
    message?: unknown;
  };
  click?: {
    link?: unknown;
    ipAddress?: unknown;
    userAgent?: unknown;
  };
  open?: {
    ipAddress?: unknown;
    userAgent?: unknown;
  };
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

function mapResendEvent(payload: ResendWebhookPayload): {
  kind: 'delivered' | 'bounce' | 'complaint' | 'o' | 'c' | 'u' | 'failed';
  bounceKind?: 'hard' | 'soft' | '';
} | null {
  const type = String(payload.type ?? '').toLowerCase();
  if (type === 'email.delivered') return { kind: 'delivered' };
  if (type === 'email.opened') return { kind: 'o' };
  if (type === 'email.clicked') return { kind: 'c' };
  if (type === 'email.complained') return { kind: 'complaint' };
  if (type === 'email.bounced') {
    return {
      kind: 'bounce',
      bounceKind: resendBounceKind(payload.data?.bounce),
    };
  }
  if (type === 'email.delivery_delayed') return { kind: 'bounce', bounceKind: 'soft' };
  if (type === 'email.failed' || type === 'email.suppressed') return { kind: 'failed' };
  return null;
}

function resendBounceKind(bounce: ResendWebhookData['bounce']): 'hard' | 'soft' {
  const type = String(bounce?.type ?? '').toLowerCase();
  if (type.includes('transient') || type.includes('temporary')) return 'soft';
  return 'hard';
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

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.find((v): v is string => typeof v === 'string' && !!v);
  return stringValue(value);
}

function isoTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new UnauthorizedException('invalid Resend webhook JSON');
  }
}

function parseSvixSignatures(header: string): Buffer[] {
  return header
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(',', 2))
    .filter(([version, signature]) => version === 'v1' && !!signature)
    .map(([, signature]) => Buffer.from(signature, 'base64'));
}

function createSvixSignature(secret: string, signedPayload: string): Buffer {
  const normalized = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(normalized, 'base64');
  return createHmac('sha256', key).update(signedPayload, 'utf8').digest();
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
