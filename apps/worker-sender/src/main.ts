import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { Prisma, PrismaClient, type EmailChannel } from '@prisma/client';
import { rewriteHtml, signTrackingToken } from '@sendmast/email-tracking';
import { QUEUE_NAMES } from '@sendmast/shared';
import { buildClickHouseClient } from '@sendmast/clickhouse';
import { getTransportForAccount } from './transport';
import { QuotaManager } from './quota';
import { runArchiveJob } from './archive';
import { applyCustomTags, indexCustomTags } from './custom-tags';
import { applySystemTags, ensureUnsubscribeFooter, injectPreheader } from './system-tags';
import { getActiveTrackingDomains, pickTrackingHost } from './tracking-pool';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TRACKING_SECRET = process.env.TRACKING_TOKEN_SECRET;
// `TRACKING_BASE_URL` (env) is intentionally NOT consumed here any more —
// every outbound URL is built from a host picked out of the
// `tracking_domains` pool (see `tracking-pool.ts`). Kept around in env
// schemas for the API's own URL building (none today; placeholder for
// future). Pool empty = send fails — see the recipient-fail path below.
const SEND_CONCURRENCY = Number(process.env.SEND_CONCURRENCY ?? '8');

// Fairness cap: max recipients kept in-flight (queued but not yet sent) per channel
// account. Sends drain through ONE shared FIFO queue, so without this cap an
// earlier/larger campaign front-loads tens of thousands of jobs and starves any
// campaign that starts later (head-of-line blocking). Bounding per-channel depth
// keeps the shared queue shallow and interleaved, so the worker drains all
// active email channels (hence all campaigns) fairly. The 1Hz tick refills as the
// worker drains, so a shallow buffer never starves the workers nor caps
// throughput — it only changes WHICH jobs sit in the queue, not how fast they
// leave it.
const MAX_INFLIGHT_PER_CHANNEL = Number(process.env.MAX_INFLIGHT_PER_CHANNEL ?? '2000');
const FLOW_RECOVERY_AGE_MS = Number(process.env.FLOW_RECOVERY_AGE_MS ?? '10000');
const FLOW_RECOVERY_BATCH = Number(process.env.FLOW_RECOVERY_BATCH ?? '100');

if (!TRACKING_SECRET) {
  throw new Error('TRACKING_TOKEN_SECRET is required');
}

const prisma = new PrismaClient();
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const quota = new QuotaManager(connection);

const sendEmailQueue = new Queue(QUEUE_NAMES.SEND_EMAIL, {
  connection,
  defaultJobOptions: {
    // Per-recipient send jobs are idempotent via DB recipient.status, so
    // we don't need BullMQ history for dedupe — drop completed jobs
    // immediately to keep Redis lean. Failed jobs are retained 7d for
    // post-mortem.
    removeOnComplete: true,
    removeOnFail: { age: 86400 * 7 },
  },
});

const sendTickQueue = new Queue(QUEUE_NAMES.SEND_TICK, { connection });
const archiveQueue = new Queue(QUEUE_NAMES.ARCHIVE_RECIPIENTS, { connection });

// ClickHouse client for the archive job. Created lazily here (not in archive.ts)
// so unit tests can swap it; in prod it's always the env-derived singleton.
const ch = buildClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  database: process.env.CLICKHOUSE_DATABASE ?? 'sendmast',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
});

interface DispatchJobData {
  campaignId: string;
  accountId: string;
}

interface SendJobData {
  /** Campaign send: a campaign_recipients row id. */
  recipientId?: string;
  /** Flow/automation send: a shop_automation_sends row id (Klaviyo-style). */
  flowSendId?: string;
  emailChannelId: string;
}

/** Automation types that are transactional (no unsubscribe, sent regardless of opt-out). */
const TRANSACTIONAL_AUTOMATIONS = new Set(['order_paid', 'order_shipped']);

// ============================================================================
// EmailChannel cache (rebuilt by tick at most every 30s)
// ============================================================================

interface EmailChannelCacheEntry {
  account: EmailChannel;
  loadedAt: number;
}

const emailChannelCache = new Map<string, EmailChannelCacheEntry>();
const EMAIL_CHANNEL_TTL_MS = 30_000;

async function getEmailChannel(id: string): Promise<EmailChannel | null> {
  const now = Date.now();
  const cached = emailChannelCache.get(id);
  if (cached && cached.loadedAt + EMAIL_CHANNEL_TTL_MS > now) return cached.account;
  const fresh = await prisma.emailChannel.findUnique({ where: { id } });
  if (fresh) emailChannelCache.set(id, { account: fresh, loadedAt: now });
  else emailChannelCache.delete(id);
  return fresh;
}

// ============================================================================
// Sender domain → email channel lookup (cached for 30s, used by runSend)
// ============================================================================

const routingCache = new Map<string, { emailChannelId: string | null; until: number }>();
const ROUTING_TTL_MS = 30_000;

async function resolveEmailChannelIdForDomain(domain: string): Promise<string | null> {
  const now = Date.now();
  const cached = routingCache.get(domain);
  if (cached && cached.until > now) return cached.emailChannelId;

  const sd = await prisma.senderDomain.findFirst({
    where: { domain },
    select: { emailChannelId: true },
  });
  const value = sd?.emailChannelId ?? null;
  routingCache.set(domain, { emailChannelId: value, until: now + ROUTING_TTL_MS });
  return value;
}

async function persistCampaignTrackingLinks(
  accountId: string,
  recipientId: string,
  links: Array<{ index: number; url: string }>,
) {
  await prisma.$transaction(async (tx) => {
    await tx.trackingLink.deleteMany({ where: { recipientId } });
    if (links.length === 0) return;
    await tx.trackingLink.createMany({
      data: links.map((l) => ({
        accountId,
        recipientId,
        linkIndex: l.index,
        url: l.url,
      })),
    });
  });
}

async function persistAutomationTrackingLinks(
  accountId: string,
  automationSendId: string,
  links: Array<{ index: number; url: string }>,
) {
  await prisma.$transaction(async (tx) => {
    await tx.trackingLink.deleteMany({ where: { automationSendId } });
    if (links.length === 0) return;
    await tx.trackingLink.createMany({
      data: links.map((l) => ({
        accountId,
        automationSendId,
        linkIndex: l.index,
        url: l.url,
      })),
    });
  });
}

// ============================================================================
// Dispatch — only materialises recipient rows. Tick handles fan-out.
// ============================================================================

async function runDispatch(job: Job<DispatchJobData>) {
  const { campaignId, accountId } = job.data;
  console.log(`[dispatch ${campaignId}] starting (materialise only)`);

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, accountId },
    include: { lists: { orderBy: { position: 'asc' } }, senders: { orderBy: { position: 'asc' } } },
  });
  if (!campaign) throw new Error('Campaign not found');
  if (
    campaign.status === 'paused' ||
    campaign.status === 'canceled' ||
    campaign.status === 'sent'
  ) {
    console.log(`[dispatch ${campaignId}] status=${campaign.status}, skipping`);
    return;
  }

  const finalCount = await materialiseRecipients(campaign, accountId);

  // Empty audience that survived API pre-flight (race: every contact got
  // unsubscribed in the gap, or the lists got emptied). Mark as sent with
  // 0 recipients so it doesn't dangle in scheduled/sending forever.
  if (finalCount === 0) {
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ['scheduled', 'sending'] } },
      data: {
        status: 'sent',
        totalRecipients: 0,
        sentAt: new Date(),
      },
    });
    console.log(`[dispatch ${campaignId}] empty audience — marked sent with 0 recipients`);
    return;
  }

  // Persist the final recipient count we just materialised. For the
  // segment-enabled path the API already set this before enqueuing, so we
  // skip the write to keep that flow untouched (and to avoid clobbering
  // the API's count if API-side and worker-side counts ever drift).
  if (campaign.totalRecipients === 0) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { totalRecipients: finalCount },
    });
  }

  // For scheduled campaigns the API kept status='scheduled'; flip to sending
  // now that recipient rows exist so the tick scheduler can start picking up.
  await prisma.campaign.updateMany({
    where: { id: campaignId, status: 'scheduled' },
    data: { status: 'sending', sendingStartedAt: new Date() },
  });

  console.log(`[dispatch ${campaignId}] materialise complete (${finalCount} recipients)`);
}

/**
 * Stream recipients into `campaign_recipients` in cursor-paginated batches.
 *
 * Idempotency:
 *   - `skipDuplicates: true` makes per-row inserts safe under retry.
 *   - The early-exit shortcut (`existing >= totalRecipients`) only fires
 *     when totalRecipients is set AND already met — i.e. the segment-enabled
 *     API path has already done the work and a queue retry is wasteful.
 *     For the list-only path (totalRecipients=0 at entry) we always run
 *     the full streaming insert; the unique-index dedup handles retries.
 *
 * Returns the post-condition recipient count so the caller can persist it
 * back to `campaign.totalRecipients` and decide whether to short-circuit
 * to "sent" on an empty audience.
 */
async function materialiseRecipients(
  campaign: {
    id: string;
    fromEmail: string;
    lists: { listId: string }[];
    senders: { fromEmail: string; fromName: string }[];
    totalRecipients: number;
  },
  accountId: string,
): Promise<number> {
  const existing = await prisma.campaignRecipient.count({
    where: { campaignId: campaign.id },
  });
  if (campaign.totalRecipients > 0 && existing >= campaign.totalRecipients) {
    return existing;
  }

  // Multi-sender campaigns round-robin a from address onto each recipient.
  // We seed the rotation index from `existing` so a mid-stream retry keeps
  // the distribution roughly even instead of restarting at sender 0.
  const senders = campaign.senders;
  const rotate = senders.length > 1;

  // Resolve the email channel each sender's domain routes to, so we can stamp
  // it per recipient (cross-channel campaigns route each recipient independently).
  const senderChannels: (string | null)[] = [];
  for (const s of senders) {
    const d = s.fromEmail.split('@')[1]?.toLowerCase();
    senderChannels.push(d ? await resolveEmailChannelIdForDomain(d) : null);
  }
  const primaryDomain = (senders[0]?.fromEmail ?? campaign.fromEmail).split('@')[1]?.toLowerCase();
  const primaryChannel = primaryDomain ? await resolveEmailChannelIdForDomain(primaryDomain) : null;

  const listIds = campaign.lists.map((l) => l.listId);
  // No lists means this is the segment-only path; API already materialised
  // (we wouldn't be here with totalRecipients=0 in the segment case unless
  // the API's materialisation crashed mid-flight, in which case `existing`
  // is the truth and the tick scheduler will pick up what's there).
  if (listIds.length === 0) return existing;

  // {{list_name}} is captured per recipient at materialisation: each contact
  // gets the name of the target list THEY belong to — the FIRST one by
  // selection order (listIds is ordered by CampaignList.position) when the
  // contact is in several. Frozen here so a later membership change can't drift
  // the rendered email and so runSend needs no extra query. Build id→name once.
  const listNameById = new Map(
    (
      await prisma.contactList.findMany({
        where: { id: { in: listIds } },
        select: { id: true, name: true },
      })
    ).map((l) => [l.id, l.name]),
  );

  const PAGE = 5000;
  let cursor: string | undefined;
  let inserted = existing;

  while (true) {
    const batch = await prisma.contact.findMany({
      where: {
        accountId,
        subscriptionStatus: 'subscribed',
        memberships: { some: { listId: { in: listIds } } },
      },
      select: {
        id: true,
        email: true,
        memberships: {
          where: { listId: { in: listIds } },
          select: { listId: true },
        },
      },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;

    await prisma.campaignRecipient.createMany({
      data: batch.map((c, j) => {
        const idx = (inserted + j) % senders.length;
        const s = rotate ? senders[idx] : null;
        const member = new Set(c.memberships.map((m) => m.listId));
        const firstListId = listIds.find((id) => member.has(id));
        const listName = firstListId ? (listNameById.get(firstListId) ?? null) : null;
        return {
          accountId,
          campaignId: campaign.id,
          contactId: c.id,
          email: c.email,
          status: 'pending' as const,
          listName,
          fromEmail: s?.fromEmail ?? null,
          fromName: s?.fromName ?? null,
          emailChannelId: rotate ? senderChannels[idx] : primaryChannel,
        };
      }),
      skipDuplicates: true,
    });
    inserted += batch.length;
    cursor = batch[batch.length - 1].id;
  }

  console.log(`[dispatch ${campaign.id}] materialised ${inserted} recipient rows`);
  return inserted;
}

// ============================================================================
// Tick — runs every second; fairly enqueues sends per email channel.
// ============================================================================

/**
 * Re-publish automation sends left pending after a transient Redis failure.
 * The DB row is the durable outbox; deterministic BullMQ job IDs make this
 * safe when the original enqueue actually succeeded but its acknowledgement
 * was lost.
 */
async function recoverPendingFlowSends(): Promise<void> {
  const pending = await prisma.shopAutomationSend.findMany({
    where: {
      status: 'pending',
      emailChannelId: { not: null },
      createdAt: { lt: new Date(Date.now() - FLOW_RECOVERY_AGE_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: FLOW_RECOVERY_BATCH,
    select: { id: true, emailChannelId: true },
  });

  for (const send of pending) {
    const emailChannelId = send.emailChannelId;
    if (!emailChannelId) continue;
    const jobId = `f-${send.id}`;
    try {
      let existing = await sendEmailQueue.getJob(jobId);
      if (existing && (await existing.getState()) === 'failed') {
        await existing.remove();
        existing = undefined;
      }
      if (!existing) {
        await sendEmailQueue.add(
          'send',
          { flowSendId: send.id, emailChannelId },
          {
            jobId,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
          },
        );
      }
      await prisma.shopAutomationSend.updateMany({
        where: { id: send.id, status: 'pending' },
        data: { status: 'queued' },
      });
    } catch (err) {
      console.error(`[tick] failed to recover flow send ${send.id}:`, err);
    }
  }
}

async function runTick(_job: Job): Promise<void> {
  await recoverPendingFlowSends();

  // 1. Find all sending campaigns. We need accountId (tenant) to enforce
  //    the per-tenant prepaid quota and fromEmail to route to the email channel.
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'sending' },
    select: { id: true, accountId: true, fromEmail: true },
  });
  if (campaigns.length === 0) return;

  // 2. Look up per-tenant remaining quota for every involved tenant.
  //    A live tenant->remaining map drives both an early skip (saves provider calls
  //    work) and a per-tick budget cap (prevents queuing 1000 jobs when
  //    only 10 quota are left). The map is mutated as we plan enqueues so
  //    multiple campaigns sharing a tenant share the budget within this tick.
  const tenantIds = Array.from(new Set(campaigns.map((c) => c.accountId)));
  const tenants = await prisma.account.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, sendQuotaRemaining: true },
  });
  const tenantBudget = new Map<string, number>(tenants.map((t) => [t.id, t.sendQuotaRemaining]));

  // 2b. Force-finalize campaigns whose tenant has zero quota. Without this
  //     the campaign would sit in `status='sending'` indefinitely (the loop
  //     below would `continue` past it every tick). Per product spec: when
  //     quota is exhausted mid-campaign — including the partial case where
  //     a previous tick drained the last unit — we mark all still-pending
  //     and queued recipients as failed and flip the campaign to 'sent'
  //     (sentAt=now), so the user sees a definitive end-state instead of
  //     a stuck "发送中" indicator. The wizard's quota=0 send-button gate
  //     prevents new sends from entering this state in the first place.
  const exhausted = campaigns.filter((c) => (tenantBudget.get(c.accountId) ?? 0) <= 0);
  for (const c of exhausted) {
    try {
      await prisma.$transaction([
        prisma.campaignRecipient.updateMany({
          where: {
            campaignId: c.id,
            status: { in: ['pending', 'queued'] },
          },
          data: {
            status: 'failed',
            errorMessage: '账户额度不足,本次未发送',
          },
        }),
        prisma.campaign.update({
          where: { id: c.id },
          data: { status: 'sent', sentAt: new Date() },
        }),
      ]);
      console.log(
        `[tick] tenant=${c.accountId} quota=0; finalised campaign ${c.id} ` +
          `(unsent recipients flipped to failed, status=sent)`,
      );
    } catch (err) {
      console.error(`[tick] failed to finalise quota-exhausted campaign ${c.id}:`, err);
    }
  }
  // After finalisation those campaigns are out of the working set — only
  // tenants with budget > 0 reach the routing step below.
  if (exhausted.length === campaigns.length) return;

  // 3. Eligible campaigns = sending campaigns whose tenant still has quota.
  //    Routing is now PER RECIPIENT: each campaign_recipients row carries the
  //    email channel resolved from its assigned sender's domain, so a single
  //    campaign may fan out across multiple email channels.
  const eligibleCampaignIds: string[] = [];
  const campaignTenant = new Map<string, string>();
  for (const c of campaigns) {
    if ((tenantBudget.get(c.accountId) ?? 0) <= 0) continue;
    eligibleCampaignIds.push(c.id);
    campaignTenant.set(c.id, c.accountId);
  }
  if (eligibleCampaignIds.length === 0) return;

  // 3b. Defensive backfill for legacy rows with no email_channel_id (new sends
  //     are always stamped at materialisation; the migration backfilled
  //     in-flight rows, so this is usually a no-op). NULL -> campaign primary
  //     channel resolved from Campaign.fromEmail.
  const nullCount = await prisma.campaignRecipient.count({
    where: { campaignId: { in: eligibleCampaignIds }, status: 'pending', emailChannelId: null },
  });
  if (nullCount > 0) {
    for (const c of campaigns) {
      if (!campaignTenant.has(c.id)) continue;
      const domain = c.fromEmail.split('@')[1]?.toLowerCase();
      if (!domain) continue;
      const channelId = await resolveEmailChannelIdForDomain(domain);
      if (!channelId) continue;
      await prisma.campaignRecipient.updateMany({
        where: { campaignId: c.id, status: 'pending', emailChannelId: null },
        data: { emailChannelId: channelId },
      });
    }
  }

  // 4. Per email channel: compute channel-tier budget (min of the 4 rate tiers),
  //    take that many pending recipients for this channel across all eligible
  //    campaigns, then enqueue while respecting each owning tenant's remaining
  //    prepaid quota (mutated in-tick so campaigns sharing a tenant don't
  //    double-spend).
  const channelBuckets = await prisma.campaignRecipient.groupBy({
    by: ['emailChannelId'],
    where: {
      campaignId: { in: eligibleCampaignIds },
      status: 'pending',
      emailChannelId: { not: null },
    },
  });

  // Current in-flight (queued, not yet sent) depth per channel. Used to bound how
  // much we add to the shared FIFO queue this tick so no single channel/campaign
  // can pile a deep backlog and starve others (see MAX_INFLIGHT_PER_CHANNEL).
  const queuedBuckets = await prisma.campaignRecipient.groupBy({
    by: ['emailChannelId'],
    where: { status: 'queued', emailChannelId: { not: null } },
    _count: { _all: true },
  });
  const inflightByEmailChannel = new Map<string, number>(
    queuedBuckets
      .filter((b): b is typeof b & { emailChannelId: string } => b.emailChannelId != null)
      .map((b) => [b.emailChannelId, b._count._all]),
  );

  for (const bucket of channelBuckets) {
    const emailChannelId = bucket.emailChannelId;
    if (!emailChannelId) continue;
    const acct = await getEmailChannel(emailChannelId);
    if (!acct || acct.status !== 'active') continue;

    let budget = await quota.getAvailable(emailChannelId, acct);
    if (budget <= 0) continue;

    // Cap by remaining in-flight headroom for this channel so the shared send queue
    // stays shallow and fair across all active email channels / campaigns.
    const headroom = MAX_INFLIGHT_PER_CHANNEL - (inflightByEmailChannel.get(emailChannelId) ?? 0);
    if (headroom <= 0) continue;
    if (budget > headroom) budget = headroom;

    const candidates = await prisma.campaignRecipient.findMany({
      where: { emailChannelId, status: 'pending', campaignId: { in: eligibleCampaignIds } },
      take: budget,
      orderBy: { id: 'asc' },
      select: { id: true, campaignId: true },
    });

    const toQueue: string[] = [];
    for (const r of candidates) {
      if (budget <= 0) break;
      const tenantId = campaignTenant.get(r.campaignId);
      if (!tenantId) continue;
      const tenantRemaining = tenantBudget.get(tenantId) ?? 0;
      if (tenantRemaining <= 0) continue;
      toQueue.push(r.id);
      tenantBudget.set(tenantId, tenantRemaining - 1);
      budget -= 1;
    }
    if (toQueue.length === 0) continue;

    await sendEmailQueue.addBulk(
      toQueue.map((id) => ({
        name: 'send',
        data: { recipientId: id, emailChannelId },
        opts: { jobId: `r-${id}` },
      })),
    );
    await prisma.campaignRecipient.updateMany({
      where: { id: { in: toQueue } },
      data: { status: 'queued' },
    });
  }
}

/**
 * Load the account's custom tags and index them for fast lookup. Done once
 * per recipient send (~ms-scale on a small table); not cached because tags
 * may change between sends and a stale cache would surprise users editing
 * mid-campaign. Add a per-tick LRU here if profiling shows it matters.
 */
async function loadCustomTagIndex(accountId: string): Promise<Map<string, string[]>> {
  const tags = await prisma.customTag.findMany({
    where: { accountId },
    select: { name: true, values: true },
  });
  return indexCustomTags(tags);
}

// ============================================================================
// Send — actual transport call. Reserves 1 unit of tenant prepaid quota
// before calling the provider; on success also consumes 1 unit of channel-tier sliding-
// window quota. Tenant quota is the hard cash limit (counts every attempt);
// channel-tier quota is the rate limit (counts only successes).
// ============================================================================

async function runSend(job: Job<SendJobData>) {
  if (!job.data.recipientId) return;
  const r = await prisma.campaignRecipient.findUnique({
    where: { id: job.data.recipientId },
    include: { campaign: true },
  });
  if (!r) return;
  if (r.status === 'sent' || r.status === 'failed' || r.status === 'skipped') return;

  const c = r.campaign;
  // Per-recipient sender assigned at materialisation for multi-sender
  // campaigns; NULL on single-sender campaigns (and all pre-feature rows),
  // where we fall back to the campaign's primary from address.
  const fromEmail = r.fromEmail ?? c.fromEmail;
  const fromName = r.fromName ?? c.fromName;

  if (c.status === 'paused') {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'pending' },
    });
    return;
  }
  if (c.status === 'canceled') {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'skipped' },
    });
    return;
  }

  if (!c.html) {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'failed', errorMessage: '活动尚未设置邮件正文' },
    });
    return;
  }

  // Use the email channel the tick scheduler picked for us. If it has been
  // retired/suspended in the meantime, fail the recipient — admin needs to
  // re-bind the sender domain.
  const acct = await getEmailChannel(job.data.emailChannelId);
  if (!acct) {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'failed', errorMessage: '邮件通道已不存在' },
    });
    return;
  }
  if (acct.status !== 'active') {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'failed', errorMessage: `邮件通道 ${acct.name} 当前状态为 ${acct.status}` },
    });
    return;
  }

  // Pick a tracking host for this recipient before building any URL.
  // Same recipient → same host (hashed selection) so opens/clicks/unsubs
  // for one user all hit one domain. Empty pool → bail this recipient
  // and force the rest of the campaign to fail; sending without a tracking
  // host would either embed `https://undefined/...` or, worse, silently
  // drop pixels — both worse than a loud failure.
  const trackingDomains = await getActiveTrackingDomains(prisma);
  const trackingHost = pickTrackingHost(trackingDomains, r.id);
  if (!trackingHost) {
    const reason = '追踪域名池为空,请联系管理员在「平台管理 > 追踪域名」中添加域名';
    await prisma.campaignRecipient.updateMany({
      where: {
        campaignId: c.id,
        status: { in: ['pending', 'queued'] },
      },
      data: { status: 'failed', errorMessage: reason },
    });
    await maybeFinaliseCampaign(c.id);
    return;
  }
  const trackingBaseUrl = `https://${trackingHost}`;

  // Generate the unsub URL up front so {unsubscribe_url} can resolve to it
  // during system-tag substitution. We also load contact name fields here
  // (one extra query per send; CampaignRecipient has contactId but no Prisma
  // relation declared, hence the explicit fetch).
  const unsubToken = signTrackingToken({ r: r.id, k: 'u' }, TRACKING_SECRET!);
  const unsubUrl = `${trackingBaseUrl}/t/u/${unsubToken}`;
  const contact = await prisma.contact.findUnique({
    where: { id: r.contactId },
    select: { firstName: true, lastName: true },
  });

  const sysCtx = {
    contact: {
      email: r.email,
      firstName: contact?.firstName ?? null,
      lastName: contact?.lastName ?? null,
    },
    campaign: { id: c.id, name: c.name, fromEmail },
    // Captured at materialisation; '' when the contact was matched only via a
    // segment or is a legacy pre-feature row.
    listName: r.listName ?? '',
    unsubscribeUrl: unsubUrl,
  };

  // Order matters: system tags first, custom tags second, then link rewrite.
  // - System first so a custom-tag value can't accidentally introduce a
  //   `{first_name}` placeholder we'd then leave unresolved.
  // - Custom tags before link rewriting so a tag value containing an
  //   `<a href>` gets picked up by rewriteHtml's click-tracking pass,
  //   matching the behaviour of hand-authored anchors.
  // ensureUnsubscribeFooter runs BEFORE applySystemTags so the auto-injected
  // footer's `{{unsubscribe_url}}` is resolved by the same substitution path
  // as user-authored links — single code path, single failure mode.
  const tagIndex = await loadCustomTagIndex(r.accountId);
  const subjectSys = applySystemTags(c.subject, sysCtx, 'text');
  const bodyHtmlSys = applySystemTags(ensureUnsubscribeFooter(c.html), sysCtx, 'html');
  const subject = applyCustomTags(subjectSys, tagIndex, 'text');
  let bodyHtml = applyCustomTags(bodyHtmlSys, tagIndex, 'html');

  // Inbox preview text (preheader): resolve tags, then inject a hidden span at
  // the top of the body so clients show it as the preview snippet — same as the
  // automation send path (runFlowSend).
  const preheaderRaw = (c.preheader ?? '').trim();
  if (preheaderRaw) {
    const ph = applyCustomTags(applySystemTags(preheaderRaw, sysCtx, 'text'), tagIndex, 'text');
    bodyHtml = injectPreheader(bodyHtml, ph);
  }

  const { html, links } = rewriteHtml(bodyHtml, {
    baseUrl: trackingBaseUrl,
    secret: TRACKING_SECRET!,
    recipientId: r.id,
    // UTM values support system variables (e.g. {{campaign_id}}, {{date}}).
    // Resolve with the 'text' context — applyUtm URL-encodes via
    // searchParams.set, so we must NOT HTML-escape here.
    utm: c.utmEnabled
      ? {
          source: applySystemTags(c.utmSource ?? 'sendmast', sysCtx, 'text'),
          medium: applySystemTags(c.utmMedium ?? 'email', sysCtx, 'text'),
          campaign: applySystemTags(c.utmCampaign ?? c.id, sysCtx, 'text'),
        }
      : undefined,
    trackClicks: c.trackClicks,
    // Hard-attribution id: the store echoes this link's query in the order's
    // landing_page, letting the order webhook attribute the conversion to this
    // exact recipient regardless of click tracking or checkout email.
    smMid: r.id,
  });

  try {
    await persistCampaignTrackingLinks(r.accountId, r.id, links);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'failed', errorMessage: `追踪链接保存失败: ${msg}` },
    });
    throw err;
  }

  let transport;
  try {
    transport = await getTransportForAccount(acct);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'failed', errorMessage: msg },
    });
    throw err;
  }

  // Atomically reserve 1 unit of tenant prepaid quota. The WHERE guard
  // prevents going negative under concurrency (multiple workers racing on
  // the last few units). When the UPDATE matches 0 rows we know the tenant
  // is out — fail this recipient AND batch-fail every other pending/queued
  // recipient on this campaign so we don't keep waking the worker.
  const reserved = await prisma.account.updateMany({
    where: { id: r.accountId, sendQuotaRemaining: { gt: 0 } },
    data: { sendQuotaRemaining: { decrement: 1 } },
  });
  if (reserved.count === 0) {
    const reason = '租户发送额度不足';
    await prisma.campaignRecipient.updateMany({
      where: {
        campaignId: c.id,
        status: { in: ['pending', 'queued'] },
      },
      data: { status: 'failed', errorMessage: reason },
    });
    await maybeFinaliseCampaign(c.id);
    return;
  }

  // Pre-assign the provider operation id and persist it BEFORE the send. the provider echoes
  // this id back as the `messageId` in delivery reports, so writing it first
  // guarantees worker-events can resolve even a bounce report that races back
  // within milliseconds. Reuse the existing id on a retried send so the provider treats
  // it as the same operation (idempotent — no duplicate email).
  const operationId = r.messageId ?? randomUUID();
  if (!r.messageId) {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { messageId: operationId },
    });
  }

  const result = await transport.send({
    from: { name: fromName, address: fromEmail },
    to: r.email,
    subject,
    html,
    operationId,
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@${fromEmail.split('@')[1]}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-SendMast-Recipient': r.id,
      'X-SendMast-Campaign': c.id,
    },
  });

  // Persist a send_logs row regardless of outcome. Best-effort: a log-write
  // failure must not block the recipient state transition or the BullMQ ack.
  try {
    await prisma.sendLog.create({
      data: {
        accountId: r.accountId,
        emailChannelId: acct.id,
        campaignId: c.id,
        recipientId: r.id,
        fromAddress: fromEmail,
        fromName: fromName,
        toAddress: r.email,
        ok: result.ok,
        providerStatus: result.providerStatus,
        messageId: result.messageId || null,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        latencyMs: result.latencyMs,
        responsePayload: toJsonInput(result.providerResponse),
      },
    });
  } catch (logErr) {
    console.error(`[send ${r.id}] failed to write send_log:`, logErr);
  }

  // ACS rejects a repeated beginSend with the same operationId
  // ("This request is invalid since the given operationId already exists.").
  // That only happens when a PRIOR attempt for this recipient already submitted
  // the message to the provider — idempotency working as intended — but our status
  // update didn't land (worker restart/stall → BullMQ retry). The email was
  // accepted, so this is a success, not a failure. Treat it as sent rather than
  // recording a spurious "发送失败".
  const duplicateOperation =
    !result.ok &&
    /operation ?id already exists/i.test(`${result.errorMessage ?? ''} ${result.errorCode ?? ''}`);
  if (duplicateOperation) {
    console.log(
      `[send ${r.id}] operationId ${operationId} already exists at ACS — prior attempt already submitted; marking sent`,
    );
  }

  if (result.ok || duplicateOperation) {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'sent', messageId: operationId, sentAt: new Date() },
    });
    // Quota is consumed only when the provider accepted the message. Failed/skipped
    // sends do not count, which is what the user wants. Best-effort: if a
    // tier rejects (rare race when several workers all flip to sent in the
    // same window) we accept the slight over-count — the next tick simply
    // sees budget=0 and throttles.
    try {
      await quota.consume(job.data.emailChannelId, acct, 1);
    } catch {}
    await maybeFinaliseCampaign(c.id);
    return;
  }

  await prisma.campaignRecipient.update({
    where: { id: r.id },
    data: {
      status: 'failed',
      errorMessage: result.errorMessage ?? '邮件通道发送失败',
    },
  });
  // Re-throw so BullMQ records this job as failed (visible in dashboard).
  // The send_logs row already carries the full provider trace.
  throw new Error(result.errorMessage ?? `provider send failed (${result.providerStatus})`);
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return { _serialiseError: 'failed to JSON.stringify provider response' };
  }
}

async function maybeFinaliseCampaign(campaignId: string): Promise<void> {
  const remaining = await prisma.campaignRecipient.count({
    where: { campaignId, status: { in: ['pending', 'queued'] } },
  });
  if (remaining === 0) {
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: 'sending' },
      data: { status: 'sent', sentAt: new Date() },
    });
  }
}

// ============================================================================
// Flow send — a Klaviyo-style first-class transactional/automation email. Not
// a campaign: it carries its own template + per-send merge vars and is tracked
// independently (source='automation'). Reuses the same tag-substitution,
// tracking-rewrite, transport, quota and provider-dedup machinery as runSend, but
// reads/writes status on shop_automation_sends instead of campaign_recipients.
// ============================================================================

async function runFlowSend(job: Job<SendJobData>) {
  const sendId = job.data.flowSendId!;
  const send = await prisma.shopAutomationSend.findUnique({
    where: { id: sendId },
    include: { automation: true },
  });
  if (!send) return;
  if (send.status === 'sent' || send.status === 'failed' || send.status === 'skipped') return;

  const automation = send.automation;
  const transactional = TRANSACTIONAL_AUTOMATIONS.has(automation.type);

  const fail = (msg: string, terminal: 'failed' | 'skipped' = 'failed') =>
    prisma.shopAutomationSend.update({
      where: { id: sendId },
      data: { status: terminal, errorMessage: terminal === 'failed' ? msg : null },
    });

  if (!automation.enabled) {
    await fail('自动化已停用', 'skipped');
    return;
  }
  // Legacy linked template, used only when no inline content was snapshotted.
  const templateId = send.templateId ?? automation.templateId;
  const fromEmail = send.fromEmail ?? automation.fromEmail;
  const fromName = send.fromName ?? automation.fromName ?? fromEmail?.split('@')[0] ?? 'Store';
  if (!fromEmail) {
    await fail('自动化未配置发件邮箱');
    return;
  }

  // Marketing flows (registration welcome / abandoned cart) respect opt-out; transactional ones
  // (order paid/shipped) send regardless — order confirmations are exempt.
  const contact = await prisma.contact.findUnique({
    where: { id: send.contactId ?? '00000000-0000-0000-0000-000000000000' },
    select: { firstName: true, lastName: true, subscriptionStatus: true },
  });
  if (!transactional && contact && contact.subscriptionStatus !== 'subscribed') {
    await fail('联系人已退订/被抑制', 'skipped');
    return;
  }

  // Content is stored inline on the send (snapshotted at enqueue) or on the
  // automation; fall back to the legacy linked template for old rows.
  let bodyHtmlRaw = send.html ?? automation.html ?? null;
  if (!bodyHtmlRaw && templateId) {
    const tpl = await prisma.emailTemplate.findUnique({
      where: { id: templateId },
      select: { html: true },
    });
    bodyHtmlRaw = tpl?.html ?? null;
  }
  if (!bodyHtmlRaw) {
    await fail('自动化邮件内容为空', 'skipped');
    return;
  }

  const acct = await getEmailChannel(job.data.emailChannelId);
  if (!acct) {
    await fail('邮件通道已不存在');
    return;
  }
  if (acct.status !== 'active') {
    await fail(`邮件通道 ${acct.name} 当前状态为 ${acct.status}`);
    return;
  }

  const trackingDomains = await getActiveTrackingDomains(prisma);
  const trackingHost = pickTrackingHost(trackingDomains, send.id);
  if (!trackingHost) {
    await fail('追踪域名池为空,请联系管理员添加追踪域名');
    return;
  }
  const trackingBaseUrl = `https://${trackingHost}`;

  // Unsubscribe only for marketing flows. Token is source-tagged ('a') so the
  // tracking endpoint resolves it against shop_automation_sends.
  const unsubUrl = transactional
    ? ''
    : `${trackingBaseUrl}/t/u/${signTrackingToken({ r: send.id, k: 'u', s: 'a' }, TRACKING_SECRET!)}`;

  const subject = send.subject?.trim() || automation.subject?.trim() || '通知';
  const mergeVars = (send.mergeVars as Record<string, string> | null) ?? null;

  const sysCtx = {
    contact: {
      email: send.email,
      firstName: contact?.firstName ?? null,
      lastName: contact?.lastName ?? null,
    },
    // Flow sends have no campaign; expose the automation id as campaign_id so
    // {{campaign_id}} / UTM still resolve to a stable identifier.
    campaign: { id: automation.id, name: subject, fromEmail },
    listName: '',
    unsubscribeUrl: unsubUrl,
    mergeVars,
  };

  const tagIndex = await loadCustomTagIndex(send.accountId);
  const subjectOut = applyCustomTags(applySystemTags(subject, sysCtx, 'text'), tagIndex, 'text');
  // Marketing emails get the unsubscribe footer; transactional ones never do.
  const bodyBase = transactional ? bodyHtmlRaw : ensureUnsubscribeFooter(bodyHtmlRaw);
  const bodyHtmlSys = applySystemTags(bodyBase, sysCtx, 'html');
  let bodyHtml = applyCustomTags(bodyHtmlSys, tagIndex, 'html');
  let preheaderOut: string | null = null;

  // Inbox preview text (preheader): resolve tags, then inject a hidden span at
  // the top of the body so clients show it as the preview snippet.
  const preheaderRaw = (send.preheader ?? automation.preheader ?? '').trim();
  if (preheaderRaw) {
    const ph = applyCustomTags(applySystemTags(preheaderRaw, sysCtx, 'text'), tagIndex, 'text');
    preheaderOut = ph;
    bodyHtml = injectPreheader(bodyHtml, ph);
  }

  const { html, links } = rewriteHtml(bodyHtml, {
    baseUrl: trackingBaseUrl,
    secret: TRACKING_SECRET!,
    recipientId: send.id,
    source: 'automation',
    utm: {
      source: 'sendmast',
      medium: 'email',
      campaign: automation.type,
    },
    trackClicks: true,
    // Keep flow sends attributable in the same way as campaign recipients:
    // the store echoes sm_mid from the landing URL back in the order webhook.
    smMid: send.id,
  });

  try {
    await persistAutomationTrackingLinks(send.accountId, send.id, links);
  } catch (err) {
    await fail(`追踪链接保存失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  let transport;
  try {
    transport = await getTransportForAccount(acct);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
    throw err;
  }

  const reserved = await prisma.account.updateMany({
    where: { id: send.accountId, sendQuotaRemaining: { gt: 0 } },
    data: { sendQuotaRemaining: { decrement: 1 } },
  });
  if (reserved.count === 0) {
    await fail('租户发送额度不足');
    return;
  }

  const operationId = send.messageId ?? randomUUID();
  if (!send.messageId) {
    await prisma.shopAutomationSend.update({
      where: { id: sendId },
      data: { messageId: operationId },
    });
  }

  const headers: Record<string, string> = {
    'X-SendMast-FlowSend': send.id,
    'X-SendMast-Automation': automation.id,
  };
  if (!transactional && unsubUrl) {
    headers['List-Unsubscribe'] = `<${unsubUrl}>, <mailto:unsubscribe@${fromEmail.split('@')[1]}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const result = await transport.send({
    from: { name: fromName, address: fromEmail },
    to: send.email,
    subject: subjectOut,
    html,
    operationId,
    headers,
  });

  // Unified provider attempt log: automation sends appear beside campaign sends in
  // the platform-admin send log. Keep only metadata here; the full automation
  // body belongs to the automation send snapshot, not the admin send log.
  try {
    await prisma.sendLog.create({
      data: {
        accountId: send.accountId,
        emailChannelId: acct.id,
        source: 'automation',
        automationId: automation.id,
        automationSendId: send.id,
        fromAddress: fromEmail,
        fromName,
        toAddress: send.email,
        ok: result.ok,
        providerStatus: result.providerStatus,
        messageId: result.messageId || operationId,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        latencyMs: result.latencyMs,
        responsePayload: toJsonInput(result.providerResponse),
        finalSubject: subjectOut,
        finalPreheader: preheaderOut,
      },
    });
  } catch (logErr) {
    console.error(`[flow send ${send.id}] failed to write send_log:`, logErr);
  }

  const duplicateOperation =
    !result.ok &&
    /operation ?id already exists/i.test(`${result.errorMessage ?? ''} ${result.errorCode ?? ''}`);

  if (result.ok || duplicateOperation) {
    await prisma.shopAutomationSend.update({
      where: { id: sendId },
      data: { status: 'sent', messageId: operationId, sentAt: new Date(), errorMessage: null },
    });
    try {
      await quota.consume(job.data.emailChannelId, acct, 1);
    } catch {}
    return;
  }

  await prisma.shopAutomationSend.update({
    where: { id: sendId },
    data: { status: 'failed', errorMessage: result.errorMessage ?? '邮件通道发送失败' },
  });
  throw new Error(result.errorMessage ?? `provider send failed (${result.providerStatus})`);
}

// ============================================================================
// Workers + bootstrap
// ============================================================================

new Worker<DispatchJobData>(QUEUE_NAMES.SEND_CAMPAIGN, runDispatch, {
  connection,
  concurrency: 4,
});

new Worker<SendJobData>(
  QUEUE_NAMES.SEND_EMAIL,
  (job) => (job.data.flowSendId ? runFlowSend(job) : runSend(job)),
  {
    connection,
    concurrency: SEND_CONCURRENCY,
  },
);

// Tick worker. concurrency=1 across this process; if multiple worker hosts
// run, BullMQ ensures each repeated occurrence is delivered to one consumer.
// Mild over-issuance under multi-host races is acceptable (token buckets clamp).
new Worker(QUEUE_NAMES.SEND_TICK, runTick, {
  connection,
  concurrency: 1,
});

// Recipient-archive worker. Long-running (minutes) but rare (once per day),
// so it gets its own dedicated worker rather than blocking the tick loop.
new Worker(
  QUEUE_NAMES.ARCHIVE_RECIPIENTS,
  async () => {
    const stats = await runArchiveJob(prisma, ch);
    console.log(
      `[archive] done in ${stats.durationMs}ms ` +
        `(${stats.campaignsArchived}/${stats.campaignsScanned} campaigns, ` +
        `${stats.recipientsArchived} recipients moved to ClickHouse)`,
    );
  },
  { connection, concurrency: 1 },
);

async function bootstrapTickJob() {
  // BullMQ requires unique repeat key. Re-adding with the same pattern is a no-op.
  await sendTickQueue.add(
    'tick',
    {},
    {
      repeat: { pattern: '*/1 * * * * *' },
      removeOnComplete: true,
      removeOnFail: { count: 50 },
    },
  );
  console.log('worker-sender: send-tick scheduler registered (1Hz)');
}

bootstrapTickJob().catch((err) => {
  console.error('Failed to bootstrap send-tick:', err);
});

async function bootstrapArchiveJob() {
  // Daily at 03:15 UTC — late enough that the previous day's sends have
  // settled, early enough that ops sees results before the morning standup.
  // Re-adding with the same repeat key is a no-op, so this is idempotent
  // across worker restarts.
  await archiveQueue.add(
    'daily',
    {},
    {
      repeat: { pattern: '15 3 * * *' },
      removeOnComplete: true,
      removeOnFail: { count: 30 },
    },
  );
  console.log('worker-sender: recipient-archive scheduler registered (daily 03:15 UTC)');
}

bootstrapArchiveJob().catch((err) => {
  console.error('Failed to bootstrap recipient-archive:', err);
});

console.log(`worker-sender started; concurrency=${SEND_CONCURRENCY}; tick scheduler enabled`);

async function shutdown() {
  console.log('Shutting down worker-sender...');
  await sendEmailQueue.close();
  await sendTickQueue.close();
  await archiveQueue.close();
  await ch.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
