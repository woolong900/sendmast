import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { Prisma, PrismaClient, type AcsAccount } from '@prisma/client';
import { rewriteHtml, signTrackingToken } from '@sendmast/email-tracking';
import { QUEUE_NAMES } from '@sendmast/shared';
import { buildClickHouseClient } from '@sendmast/clickhouse';
import { getTransportForAccount } from './transport';
import { QuotaManager } from './quota';
import { runArchiveJob } from './archive';
import { applyCustomTags, indexCustomTags } from './custom-tags';
import { applySystemTags, ensureUnsubscribeFooter } from './system-tags';
import { getActiveTrackingDomains, pickTrackingHost } from './tracking-pool';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TRACKING_SECRET = process.env.TRACKING_TOKEN_SECRET;
// `TRACKING_BASE_URL` (env) is intentionally NOT consumed here any more —
// every outbound URL is built from a host picked out of the
// `tracking_domains` pool (see `tracking-pool.ts`). Kept around in env
// schemas for the API's own URL building (none today; placeholder for
// future). Pool empty = send fails — see the recipient-fail path below.
const SEND_CONCURRENCY = Number(process.env.SEND_CONCURRENCY ?? '8');

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
  recipientId: string;
  acsAccountId: string;
}

// ============================================================================
// AcsAccount cache (rebuilt by tick at most every 30s)
// ============================================================================

interface AcsCacheEntry {
  account: AcsAccount;
  loadedAt: number;
}

const acsCache = new Map<string, AcsCacheEntry>();
const ACS_TTL_MS = 30_000;

async function getAcsAccount(id: string): Promise<AcsAccount | null> {
  const now = Date.now();
  const cached = acsCache.get(id);
  if (cached && cached.loadedAt + ACS_TTL_MS > now) return cached.account;
  const fresh = await prisma.acsAccount.findUnique({ where: { id } });
  if (fresh) acsCache.set(id, { account: fresh, loadedAt: now });
  else acsCache.delete(id);
  return fresh;
}

// ============================================================================
// Sender domain → ACS account lookup (cached for 30s, used by runSend)
// ============================================================================

const routingCache = new Map<string, { acsAccountId: string | null; until: number }>();
const ROUTING_TTL_MS = 30_000;

async function resolveAcsAccountIdForDomain(domain: string): Promise<string | null> {
  const now = Date.now();
  const cached = routingCache.get(domain);
  if (cached && cached.until > now) return cached.acsAccountId;

  const sd = await prisma.senderDomain.findFirst({
    where: { domain },
    select: { acsAccountId: true },
  });
  const value = sd?.acsAccountId ?? null;
  routingCache.set(domain, { acsAccountId: value, until: now + ROUTING_TTL_MS });
  return value;
}

// ============================================================================
// Dispatch — only materialises recipient rows. Tick handles fan-out.
// ============================================================================

async function runDispatch(job: Job<DispatchJobData>) {
  const { campaignId, accountId } = job.data;
  console.log(`[dispatch ${campaignId}] starting (materialise only)`);

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, accountId },
    include: { lists: true, senders: { orderBy: { position: 'asc' } } },
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

  const listIds = campaign.lists.map((l) => l.listId);
  // No lists means this is the segment-only path; API already materialised
  // (we wouldn't be here with totalRecipients=0 in the segment case unless
  // the API's materialisation crashed mid-flight, in which case `existing`
  // is the truth and the tick scheduler will pick up what's there).
  if (listIds.length === 0) return existing;

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
      select: { id: true, email: true },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;

    await prisma.campaignRecipient.createMany({
      data: batch.map((c, j) => {
        const s = rotate ? senders[(inserted + j) % senders.length] : null;
        return {
          accountId,
          campaignId: campaign.id,
          contactId: c.id,
          email: c.email,
          status: 'pending' as const,
          fromEmail: s?.fromEmail ?? null,
          fromName: s?.fromName ?? null,
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
// Tick — runs every second; fairly enqueues sends per ACS account.
// ============================================================================

async function runTick(_job: Job): Promise<void> {
  // 1. Find all sending campaigns. We need accountId (tenant) to enforce
  //    the per-tenant prepaid quota and fromEmail to route to ACS.
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'sending' },
    select: { id: true, accountId: true, fromEmail: true },
  });
  if (campaigns.length === 0) return;

  // 2. Look up per-tenant remaining quota for every involved tenant.
  //    A live tenant->remaining map drives both an early skip (saves ACS
  //    work) and a per-tick budget cap (prevents queuing 1000 jobs when
  //    only 10 quota are left). The map is mutated as we plan enqueues so
  //    multiple campaigns sharing a tenant share the budget within this tick.
  const tenantIds = Array.from(new Set(campaigns.map((c) => c.accountId)));
  const tenants = await prisma.account.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, sendQuotaRemaining: true },
  });
  const tenantBudget = new Map<string, number>(
    tenants.map((t) => [t.id, t.sendQuotaRemaining]),
  );

  // 2b. Force-finalize campaigns whose tenant has zero quota. Without this
  //     the campaign would sit in `status='sending'` indefinitely (the loop
  //     below would `continue` past it every tick). Per product spec: when
  //     quota is exhausted mid-campaign — including the partial case where
  //     a previous tick drained the last unit — we mark all still-pending
  //     and queued recipients as failed and flip the campaign to 'sent'
  //     (sentAt=now), so the user sees a definitive end-state instead of
  //     a stuck "发送中" indicator. The wizard's quota=0 send-button gate
  //     prevents new sends from entering this state in the first place.
  const exhausted = campaigns.filter(
    (c) => (tenantBudget.get(c.accountId) ?? 0) <= 0,
  );
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
      console.error(
        `[tick] failed to finalise quota-exhausted campaign ${c.id}:`,
        err,
      );
    }
  }
  // After finalisation those campaigns are out of the working set — only
  // tenants with budget > 0 reach the routing step below.
  if (exhausted.length === campaigns.length) return;

  // 3. Group eligible campaigns (tenant has quota) by ACS account.
  const groups = new Map<string, Array<{ id: string; accountId: string }>>();
  for (const c of campaigns) {
    if ((tenantBudget.get(c.accountId) ?? 0) <= 0) continue;
    const domain = c.fromEmail.split('@')[1]?.toLowerCase();
    if (!domain) continue;
    const acsAccountId = await resolveAcsAccountIdForDomain(domain);
    if (!acsAccountId) continue;
    if (!groups.has(acsAccountId)) groups.set(acsAccountId, []);
    groups.get(acsAccountId)!.push({ id: c.id, accountId: c.accountId });
  }

  // 4. Per ACS account: compute ACS-tier budget = min(remaining of 4 tiers),
  //    divide evenly across campaigns, then cap each campaign's share by the
  //    owning tenant's remaining prepaid quota.
  for (const [acsAccountId, members] of groups) {
    const acct = await getAcsAccount(acsAccountId);
    if (!acct || acct.status !== 'active') continue;

    const budget = await quota.getAvailable(acsAccountId, acct);
    if (budget === 0) continue;

    const perCampaign = Math.floor(budget / members.length);
    let leftover = budget - perCampaign * members.length;

    for (const { id: cid, accountId: tenantId } of members) {
      const tenantRemaining = tenantBudget.get(tenantId) ?? 0;
      if (tenantRemaining <= 0) continue;

      let myShare = perCampaign + (leftover > 0 ? 1 : 0);
      if (leftover > 0) leftover -= 1;
      // Cap by tenant prepaid quota — we never enqueue more than the tenant
      // can pay for, even if ACS-tier budget would allow more.
      myShare = Math.min(myShare, tenantRemaining);
      if (myShare === 0) continue;

      const recipients = await prisma.campaignRecipient.findMany({
        where: { campaignId: cid, status: 'pending' },
        take: myShare,
        orderBy: { id: 'asc' },
        select: { id: true },
      });
      if (recipients.length === 0) continue;

      await sendEmailQueue.addBulk(
        recipients.map((r) => ({
          name: 'send',
          data: { recipientId: r.id, acsAccountId },
          opts: { jobId: `r-${r.id}` },
        })),
      );
      await prisma.campaignRecipient.updateMany({
        where: { id: { in: recipients.map((r) => r.id) } },
        data: { status: 'queued' },
      });

      // Reduce the in-tick tenant budget so other campaigns sharing this
      // tenant don't double-spend it within the same tick.
      tenantBudget.set(tenantId, tenantRemaining - recipients.length);
    }
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
// before calling ACS; on success also consumes 1 unit of ACS-tier sliding-
// window quota. Tenant quota is the hard cash limit (counts every attempt);
// ACS-tier quota is the rate limit (counts only successes).
// ============================================================================

async function runSend(job: Job<SendJobData>) {
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

  // Use the ACS account the tick scheduler picked for us. If it has been
  // retired/suspended in the meantime, fail the recipient — admin needs to
  // re-bind the sender domain.
  const acct = await getAcsAccount(job.data.acsAccountId);
  if (!acct) {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'failed', errorMessage: 'ACS 账号已不存在' },
    });
    return;
  }
  if (acct.status !== 'active') {
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { status: 'failed', errorMessage: `ACS 账号 ${acct.name} 当前状态为 ${acct.status}` },
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
    campaign: { id: c.id, fromEmail },
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
  const bodyHtml = applyCustomTags(bodyHtmlSys, tagIndex, 'html');

  const { html } = rewriteHtml(bodyHtml, {
    baseUrl: trackingBaseUrl,
    secret: TRACKING_SECRET!,
    recipientId: r.id,
    utm: c.utmEnabled
      ? {
          source: c.utmSource ?? 'sendmast',
          medium: c.utmMedium ?? 'email',
          campaign: c.utmCampaign ?? c.id,
        }
      : undefined,
    trackClicks: c.trackClicks,
  });

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

  // Pre-assign the ACS operation id and persist it BEFORE the send. ACS echoes
  // this id back as the `messageId` in delivery reports, so writing it first
  // guarantees worker-events can resolve even a bounce report that races back
  // within milliseconds. Reuse the existing id on a retried send so ACS treats
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
        acsAccountId: acct.id,
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
  // the message to ACS — idempotency working as intended — but our status
  // update didn't land (worker restart/stall → BullMQ retry). The email was
  // accepted, so this is a success, not a failure. Treat it as sent rather than
  // recording a spurious "发送失败".
  const duplicateOperation =
    !result.ok &&
    /operation ?id already exists/i.test(
      `${result.errorMessage ?? ''} ${result.errorCode ?? ''}`,
    );
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
    // Quota is consumed only when ACS accepted the message. Failed/skipped
    // sends do not count, which is what the user wants. Best-effort: if a
    // tier rejects (rare race when several workers all flip to sent in the
    // same window) we accept the slight over-count — the next tick simply
    // sees budget=0 and throttles.
    try {
      await quota.consume(job.data.acsAccountId, acct, 1);
    } catch {}
    await maybeFinaliseCampaign(c.id);
    return;
  }

  await prisma.campaignRecipient.update({
    where: { id: r.id },
    data: {
      status: 'failed',
      errorMessage: result.errorMessage ?? 'ACS 发送失败',
    },
  });
  // Re-throw so BullMQ records this job as failed (visible in dashboard).
  // The send_logs row already carries the full provider trace.
  throw new Error(result.errorMessage ?? `ACS send failed (${result.providerStatus})`);
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
// Workers + bootstrap
// ============================================================================

new Worker<DispatchJobData>(QUEUE_NAMES.SEND_CAMPAIGN, runDispatch, {
  connection,
  concurrency: 4,
});

new Worker<SendJobData>(QUEUE_NAMES.SEND_EMAIL, runSend, {
  connection,
  concurrency: SEND_CONCURRENCY,
});

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

console.log(
  `worker-sender started; concurrency=${SEND_CONCURRENCY}; tick scheduler enabled`,
);

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
