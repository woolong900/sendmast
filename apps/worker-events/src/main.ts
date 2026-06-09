import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import {
  buildClickHouseClient,
  findArchivedRecipientById,
  insertEmailEvents,
  ZERO_UUID,
  type BounceKind,
  type EmailEventRow,
  type EmailEventType,
} from '@sendmast/clickhouse';
import { QUEUE_NAMES } from '@sendmast/shared';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const FLUSH_BATCH = Number(process.env.EVENTS_FLUSH_BATCH ?? '500');
const FLUSH_INTERVAL_MS = Number(process.env.EVENTS_FLUSH_INTERVAL_MS ?? '1000');

const prisma = new PrismaClient();
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const ch = buildClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  database: process.env.CLICKHOUSE_DATABASE ?? 'sendmast',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
});

interface EventJobData {
  kind: EmailEventType | 'o' | 'c' | 'u';
  recipientId?: string;
  externalRecipient?: string;
  messageId?: string;
  linkIndex?: number;
  linkUrl?: string;
  ip?: string;
  userAgent?: string;
  receivedAt: number;
  rawMeta?: Record<string, unknown>;
  /** Set by webhook for bounce events; '' / undefined for everything else. */
  bounceKind?: BounceKind;
  /** 'a' = the id/messageId belongs to a flow send (shop_automation_sends). */
  source?: 'a';
}

/** Normalised resolution of an event back to its owning send (campaign or flow). */
interface ResolvedSend {
  id: string;
  accountId: string;
  contactId: string | null;
  /** 'campaign' | 'flow' for the email_events.source_type column. */
  sourceType: 'campaign' | 'flow';
  /** Campaign id for campaign sends; ZERO_UUID for flow sends. */
  campaignId: string;
  /** Automation id for flow sends; null for campaigns. */
  sourceId: string | null;
  /** Present only for the hot campaign-recipient path. */
  status?: string;
}

const KIND_MAP: Record<string, EmailEventType> = {
  o: 'open',
  c: 'click',
  u: 'unsubscribe',
};

let buffer: EmailEventRow[] = [];
let flushTimer: NodeJS.Timeout | null = null;

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    await insertEmailEvents(ch, batch);
  } catch (err) {
    console.error('ClickHouse insert failed; re-queueing batch:', err);
    buffer = batch.concat(buffer);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flush();
  }, FLUSH_INTERVAL_MS);
}

async function resolveFlowSend(
  where: { id: string } | { messageId: string },
): Promise<ResolvedSend | null> {
  const send =
    'id' in where
      ? await prisma.shopAutomationSend.findUnique({
          where: { id: where.id },
          select: { id: true, accountId: true, contactId: true, automationId: true, status: true },
        })
      : await prisma.shopAutomationSend.findFirst({
          where: { messageId: where.messageId },
          select: { id: true, accountId: true, contactId: true, automationId: true, status: true },
        });
  if (!send) return null;
  return {
    id: send.id,
    accountId: send.accountId,
    contactId: send.contactId,
    sourceType: 'flow',
    campaignId: ZERO_UUID,
    sourceId: send.automationId,
    status: send.status,
  };
}

async function resolveRecipient(data: EventJobData): Promise<ResolvedSend | null> {
  // Flow send (tracking pixel/link carries source='a').
  if (data.source === 'a' && data.recipientId) {
    return resolveFlowSend({ id: data.recipientId });
  }

  if (data.recipientId) {
    const hot = await prisma.campaignRecipient.findUnique({
      where: { id: data.recipientId },
      select: {
        id: true,
        accountId: true,
        campaignId: true,
        contactId: true,
        status: true,
      },
    });
    if (hot) {
      return {
        id: hot.id,
        accountId: hot.accountId,
        contactId: hot.contactId,
        sourceType: 'campaign',
        campaignId: hot.campaignId,
        sourceId: null,
        status: hot.status,
      };
    }
    // PG miss → try the ClickHouse cold archive. This is the normal path for
    // open/click events that arrive >90 days after send (people opening old
    // newsletters from their archive). Without this fallback those events
    // would be dropped instead of recorded against the original campaign.
    const cold = await findArchivedRecipientById(ch, data.recipientId);
    if (cold) {
      return {
        id: cold.id,
        accountId: cold.accountId,
        contactId: cold.contactId,
        sourceType: 'campaign',
        campaignId: cold.campaignId,
        sourceId: null,
      };
    }
    return null;
  }
  if (data.messageId) {
    // ACS delivery/bounce report. Try campaign recipients first (the common
    // case), then flow sends.
    const hot = await prisma.campaignRecipient.findFirst({
      where: { messageId: data.messageId },
      select: { id: true, accountId: true, campaignId: true, contactId: true },
    });
    if (hot) {
      return {
        id: hot.id,
        accountId: hot.accountId,
        contactId: hot.contactId,
        sourceType: 'campaign',
        campaignId: hot.campaignId,
        sourceId: null,
      };
    }
    return resolveFlowSend({ messageId: data.messageId });
  }
  return null;
}

async function runEventJob(job: Job<EventJobData>) {
  const data = job.data;
  const eventType: EmailEventType = (KIND_MAP[data.kind as string] ?? data.kind) as EmailEventType;

  const recipient = await resolveRecipient(data);
  if (!recipient) {
    console.warn(`Event for unknown recipient (kind=${eventType})`);
    return;
  }

  // A delivery receipt (delivered/bounce) proves ACS actually accepted and
  // attempted the send. If we had optimistically marked this recipient 'failed'
  // — e.g. an `ACS beginSend timed out after 10000ms` client-side timeout where
  // the request still went through — correct it back to 'sent'. Otherwise the
  // recipient is double-counted as both 发送失败 AND 送达/弹回, and 总投放 no
  // longer reconciles (送达 + 弹回 + 失败 > 总投放). Gated on the in-memory
  // status so we don't issue a write for the common non-failed case; updateMany
  // re-checks status='failed' to stay correct under concurrency and is a no-op
  // for archived rows.
  if (
    recipient.sourceType === 'campaign' &&
    (eventType === 'delivered' || eventType === 'bounce') &&
    recipient.status === 'failed'
  ) {
    await prisma.campaignRecipient
      .updateMany({
        where: { id: recipient.id, status: 'failed' },
        data: { status: 'sent', errorMessage: null },
      })
      .catch(() => undefined);
  }

  // Suppress ONLY on hard (5xx) bounces. Wrapped in updateMany to tolerate the
  // case where the recipient row has been moved to the CH archive
  // (resolveRecipient's fallback path) — updateMany is a no-op instead of
  // throwing P2025 when no rows match.
  //
  // soft bounces (4xx transient, OR code-less sender-side policy / reputation /
  // DNS rejections like AUP#DNS) are deliberately NOT suppressed: the recipient
  // address is probably fine, so we keep it mailable rather than permanently
  // blacklisting a good contact over our own deliverability issue.
  if (eventType === 'bounce' && data.bounceKind === 'hard' && recipient.contactId) {
    // We deliberately do NOT flip campaignRecipient.status to 'failed': the
    // address WAS transmitted to (status stays 'sent'), and the bounce already
    // lives in ClickHouse where it surfaces under 弹回/无效邮箱. Counting it as
    // 发送失败 too would double-count it against 总投放. The suppression below is
    // what actually stops future sends.
    // Exclude the contact from ALL future sends. resolveAudience filters on
    // contact.subscriptionStatus, so flipping it to `bounced` is what actually
    // stops mailing a dead address — the suppression_entries row (keyed by the
    // real email) is just the durable record. Don't clobber an explicit
    // unsubscribe/complaint, which are stronger opt-outs.
    const contact = await prisma.contact.findUnique({
      where: { id: recipient.contactId },
      select: { email: true },
    });
    if (contact) {
      await prisma.contact
        .updateMany({
          where: {
            id: recipient.contactId,
            subscriptionStatus: { notIn: ['unsubscribed', 'complained'] },
          },
          data: { subscriptionStatus: 'bounced' },
        })
        .catch(() => undefined);
      await prisma.suppressionEntry
        .upsert({
          where: { accountId_email: { accountId: recipient.accountId, email: contact.email } },
          update: { reason: 'hard_bounce' },
          create: { accountId: recipient.accountId, email: contact.email, reason: 'hard_bounce' },
        })
        .catch(() => undefined);
    }
  }
  if (eventType === 'complaint' && recipient.contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: recipient.contactId },
      select: { email: true },
    });
    if (contact) {
      // A complaint is the strongest negative signal — opt the contact out of
      // future sends too (don't override a prior explicit unsubscribe).
      await prisma.contact
        .updateMany({
          where: {
            id: recipient.contactId,
            subscriptionStatus: { not: 'unsubscribed' },
          },
          data: { subscriptionStatus: 'complained' },
        })
        .catch(() => undefined);
      await prisma.suppressionEntry.upsert({
        where: { accountId_email: { accountId: recipient.accountId, email: contact.email } },
        update: { reason: 'complaint' },
        create: { accountId: recipient.accountId, email: contact.email, reason: 'complaint' },
      });
    }
  }

  buffer.push({
    account_id: recipient.accountId,
    campaign_id: recipient.campaignId,
    contact_id: recipient.contactId ?? ZERO_UUID,
    recipient_id: recipient.id,
    source_type: recipient.sourceType,
    source_id: recipient.sourceId,
    event_type: eventType,
    // CH 24.x's DateTime64 JSON parser rejects the `Z` UTC suffix; use space
    // separator and strip Z. Column is declared `DateTime64(3, 'UTC')` so
    // values are interpreted as UTC anyway.
    event_time: new Date(data.receivedAt).toISOString().replace('T', ' ').replace('Z', ''),
    ip: data.ip ?? null,
    user_agent: data.userAgent ?? null,
    link_url: data.linkUrl ?? null,
    raw_meta: data.rawMeta ? JSON.stringify(data.rawMeta) : null,
    bounce_kind: data.bounceKind ?? '',
  });

  if (buffer.length >= FLUSH_BATCH) {
    await flush();
  } else {
    scheduleFlush();
  }
}

new Worker<EventJobData>(QUEUE_NAMES.EVENTS_INGEST, runEventJob, {
  connection,
  concurrency: 16,
});

console.log('worker-events started');

async function shutdown() {
  console.log('Shutting down worker-events...');
  await flush();
  await ch.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
