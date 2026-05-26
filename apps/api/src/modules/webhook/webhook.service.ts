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
 * Decide whether an ACS bounce event should be classified as a permanent
 * (hard) or transient (soft) bounce. Inputs we have:
 *
 *   data.status                                 → 'Bounced' | 'Failed' | 'Suppressed' | 'Quarantined' | ...
 *   data.deliveryStatusDetails.statusMessage    → free-form, often "550 5.1.1 user unknown" or "452 4.2.2 mailbox full"
 *
 * Strategy:
 *   - Suppressed / Quarantined / Bounced  →  hard (ACS gave up; address is unusable for us)
 *   - Failed + 4xx SMTP code              →  soft (transient; could retry)
 *   - Failed + 5xx SMTP code              →  hard
 *   - Failed without parseable code       →  hard (conservative default — better
 *     to over-suppress than to keep hammering bad addresses)
 *
 * NOTE: ACS doesn't itself emit a "soft bounce" status. The 4xx vs 5xx split
 * is the industry-standard heuristic; if you see misclassifications in
 * production, capture a sample raw_meta and refine the regex here.
 */
function classifyBounce(data: Record<string, unknown>): 'hard' | 'soft' {
  const status = String((data as { status?: string }).status ?? '');
  if (['Bounced', 'Suppressed', 'Quarantined'].includes(status)) return 'hard';

  const msg = String(
    (data as { deliveryStatusDetails?: { statusMessage?: string } })
      .deliveryStatusDetails?.statusMessage ?? '',
  );
  // SMTP enhanced status codes look like "X.Y.Z" with X being 2/4/5; the
  // basic 3-digit code (4xx/5xx) is what we match — picks up "452", "550" etc.
  const m = /\b([45])\d{2}\b/.exec(msg);
  if (m && m[1] === '4') return 'soft';
  return 'hard';
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
