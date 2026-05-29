import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import {
  buildClickHouseClient,
  findArchivedRecipientById,
  insertEmailEvents,
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

async function resolveRecipient(data: EventJobData) {
  if (data.recipientId) {
    const hot = await prisma.campaignRecipient.findUnique({
      where: { id: data.recipientId },
      select: {
        id: true,
        accountId: true,
        campaignId: true,
        contactId: true,
      },
    });
    if (hot) return hot;
    // PG miss → try the ClickHouse cold archive. This is the normal path for
    // open/click events that arrive >90 days after send (people opening old
    // newsletters from their archive). Without this fallback those events
    // would be dropped instead of recorded against the original campaign.
    const cold = await findArchivedRecipientById(ch, data.recipientId);
    return cold;
  }
  if (data.messageId) {
    return prisma.campaignRecipient.findFirst({
      where: { messageId: data.messageId },
      select: {
        id: true,
        accountId: true,
        campaignId: true,
        contactId: true,
      },
    });
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

  // Suppress ONLY on hard (5xx) bounces. Wrapped in updateMany to tolerate the
  // case where the recipient row has been moved to the CH archive
  // (resolveRecipient's fallback path) — updateMany is a no-op instead of
  // throwing P2025 when no rows match.
  //
  // soft (4xx, transient) and unknown (no SMTP code — sender-side policy /
  // reputation / DNS rejections like AUP#DNS) are deliberately NOT suppressed:
  // the recipient address is probably fine, so we keep it mailable rather than
  // permanently blacklisting a good contact over our own deliverability issue.
  if (eventType === 'bounce' && data.bounceKind === 'hard') {
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
  if (eventType === 'complaint') {
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
    contact_id: recipient.contactId,
    recipient_id: recipient.id,
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
