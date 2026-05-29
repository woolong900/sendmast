import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../../common/queue/queue.service';
import { QUEUE_NAMES } from '@sendmast/shared';

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

/**
 * Azure Communication Services Email event types we care about.
 *
 * In production we only subscribe to `EmailDeliveryReportReceived` in Azure
 * Event Grid. open / click / unsubscribe are tracked by our own `/t/*`
 * routes (open pixel + link redirect + one-click unsubscribe), which gives
 * us per-link click data and a recipient-side definition of "open" that
 * matches what the user actually sees in the UI. The engagement-tracking
 * mapping below is kept for two reasons:
 *   1. flexibility — if we ever want ACS as a backup signal it's a one-line
 *      Azure subscription change away;
 *   2. defensive — if Azure starts pushing engagement events to a
 *      mis-configured subscription, mapAcsEvent will recognise them
 *      instead of warning "Unknown event type" forever.
 */
const ACS_EVENT_MAP: Record<string, 'delivered' | 'bounce' | 'complaint' | 'open' | 'click' | 'failed'> = {
  'Microsoft.Communication.EmailDeliveryReportReceived': 'delivered',
  'Microsoft.Communication.EmailEngagementTrackingReportReceived': 'open',
};

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly queue: QueueService) {}

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

      const ourType = mapAcsEvent(ev);
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
  'recipient address rejected',
  'recipient rejected',
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

function mapAcsEvent(ev: EventGridEvent): 'delivered' | 'bounce' | 'complaint' | 'failed' | null {
  if (ev.eventType === 'Microsoft.Communication.EmailDeliveryReportReceived') {
    const status = String((ev.data as { status?: string }).status ?? '').toLowerCase();
    if (status === 'delivered') return 'delivered';
    if (status === 'bounced' || status === 'bounce' || status === 'failed') return 'bounce';
    if (status === 'suppressed') return 'failed';
    return 'failed';
  }
  return ACS_EVENT_MAP[ev.eventType] === 'open' ? null : null;
}
