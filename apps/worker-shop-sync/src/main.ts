import 'dotenv/config';
import { Worker, Queue, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import {
  buildClickHouseClient,
  findLastClick,
  insertAttributions,
  insertOrders,
  toClickHouseDateTime,
} from '@sendmast/clickhouse';
import { QUEUE_NAMES, type ShopEventJob } from '@sendmast/shared';
import { mapCheckout, mapLineItems, mapOrder, mapShippingAddressLines } from './mapper.js';
import {
  runAbandonedFromOrder,
  runAbandonedRecovery,
  scheduleAbandonedFromOrder,
  scheduleAbandonedRecovery,
  triggerOrderPaid,
  triggerOrderShipped,
  type AbandonedJob,
  type AutomationDeps,
} from './automations.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
/** Last-click attribution window (days). */
const ATTRIBUTION_WINDOW_DAYS = Number(process.env.SHOP_ATTRIBUTION_DAYS ?? '7');

const prisma = new PrismaClient();
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const ch = buildClickHouseClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  database: process.env.CLICKHOUSE_DATABASE ?? 'sendmast',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
});

// Queues the automation hooks publish to (transactional send + delayed recovery).
const sendQueue = new Queue(QUEUE_NAMES.SEND_EMAIL, { connection });
const abandonedQueue = new Queue(QUEUE_NAMES.SHOP_ABANDONED, { connection });
const deps: AutomationDeps = { prisma, sendQueue, abandonedQueue };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// shop_orders.status is monotonic: pending → paid → shipped. The guard below
// only ever advances it forward, so an out-of-order or duplicate paid/shipped
// webhook (workers run concurrently) can never regress a more-advanced order.
const ORDER_STATUS_RANK: Record<string, number> = { pending: 0, paid: 1, shipped: 2 };

/** Statuses ranked strictly below `target` (the only ones it may advance from). */
function lowerOrderStatuses(target: string): string[] {
  const rank = ORDER_STATUS_RANK[target] ?? 0;
  return Object.keys(ORDER_STATUS_RANK).filter((s) => ORDER_STATUS_RANK[s]! < rank);
}

/**
 * Read the `sm_mid` hard-attribution id from the order's landing page. Both
 * flow recall links and campaign links stamp it; it resolves to either a
 * `shop_automation_sends.id` (flow) or a `campaign_recipients.id` (campaign).
 */
function landingPageMid(payload: Record<string, unknown>): string | null {
  const lp = payload['landing_page'];
  if (typeof lp !== 'string' || !lp) return null;
  try {
    const mid = new URL(lp).searchParams.get('sm_mid');
    return mid && UUID_RE.test(mid) ? mid : null;
  } catch {
    return null;
  }
}

/**
 * Hard attribution: resolve a `sm_mid` to the flow send that drove it. Works
 * regardless of which email the buyer used at checkout (unlike last-click,
 * which matches on the order's email). Scoped to the account so a stale/forged
 * id can't cross tenants.
 */
async function resolveFlowAttribution(
  accountId: string,
  mid: string,
): Promise<{ automationId: string; sendId: string } | null> {
  const send = await prisma.shopAutomationSend
    .findFirst({
      where: { id: mid, accountId },
      select: { id: true, automationId: true },
    })
    .catch(() => null);
  return send ? { automationId: send.automationId, sendId: send.id } : null;
}

/**
 * Hard attribution for campaigns: resolve a `sm_mid` to the campaign recipient
 * it was stamped on. Like the flow case, this is independent of the checkout
 * email and of click tracking (the id rides the link's query string).
 */
async function resolveCampaignAttribution(
  accountId: string,
  mid: string,
): Promise<{ campaignId: string; contactId: string } | null> {
  const rec = await prisma.campaignRecipient
    .findFirst({
      where: { id: mid, accountId },
      select: { campaignId: true, contactId: true },
    })
    .catch(() => null);
  return rec ? { campaignId: rec.campaignId, contactId: rec.contactId } : null;
}

/** Upsert a contact by (accountId, email); shopyy buyers source = 'shopyy'. */
async function upsertContact(accountId: string, email: string): Promise<string> {
  const normalized = email.toLowerCase().trim();
  const row = await prisma.contact.upsert({
    where: { accountId_email: { accountId, email: normalized } },
    update: {},
    create: { accountId, email: normalized, source: 'shopyy' },
    select: { id: true },
  });
  return row.id;
}

async function touchSync(connectionId: string): Promise<void> {
  await prisma.shopConnection
    .update({ where: { id: connectionId }, data: { lastSyncAt: new Date() } })
    .catch(() => undefined);
}

async function handleOrder(job: ShopEventJob, shipped: boolean): Promise<void> {
  const order = mapOrder(job.payload);
  if (!order) {
    console.warn(`[shop-sync] order payload missing id/email (store conn ${job.connectionId})`);
    return;
  }
  const contactId = await upsertContact(job.accountId, order.email);
  const newStatus = shipped ? 'shipped' : 'paid';

  // Attribution is only meaningful on the paid event (the conversion). The
  // landing-page sm_mid resolves to exactly one of a flow send or a campaign
  // recipient (each is a distinct random UUID), so we try flow first.
  const mid = shipped ? null : landingPageMid(job.payload);
  const flowAttr = mid ? await resolveFlowAttribution(job.accountId, mid).catch(() => null) : null;
  const campaignHard =
    mid && !flowAttr
      ? await resolveCampaignAttribution(job.accountId, mid).catch(() => null)
      : null;

  // Last-click is the soft fallback for campaigns; the hard sm_mid match wins
  // when present (works even if the buyer checked out with a different email).
  const lastClick =
    shipped || campaignHard
      ? null
      : await findLastClick(ch, {
          accountId: job.accountId,
          contactId,
          withinDays: ATTRIBUTION_WINDOW_DAYS,
        }).catch(() => null);

  // Resolved campaign attribution (hard sm_mid match, else last-click).
  const campaignAttr = campaignHard
    ? { campaignId: campaignHard.campaignId, contactId: campaignHard.contactId, model: 'hard_sm_mid' }
    : lastClick
      ? { campaignId: lastClick.campaignId, contactId, model: 'last_click_7d' }
      : null;

  const saved = await prisma.shopOrder.upsert({
    where: {
      shopConnectionId_externalOrderId: {
        shopConnectionId: job.connectionId,
        externalOrderId: order.externalOrderId,
      },
    },
    create: {
      accountId: job.accountId,
      shopConnectionId: job.connectionId,
      externalOrderId: order.externalOrderId,
      orderNo: order.orderNo ?? null,
      customerEmail: order.email,
      contactId,
      value: order.value,
      currency: order.currency,
      // First touch (e.g. a paid/shipped webhook arriving before create): seed
      // the row at this event's status. Subsequent events advance it via the
      // monotonic guard below — never here in the update branch.
      status: newStatus,
      orderTime: order.orderTime,
      attributedCampaignId: campaignAttr?.campaignId ?? null,
      attributedContactId: campaignAttr?.contactId ?? null,
      attributionModel: campaignAttr?.model ?? null,
      attributedAutomationId: flowAttr?.automationId ?? null,
      attributedSendId: flowAttr?.sendId ?? null,
      raw: job.payload as object,
    },
    // Note: `status` is deliberately NOT set here — it's advanced separately by
    // the monotonic guard so a late/duplicate paid can't downgrade a shipped order.
    update: {
      orderNo: order.orderNo ?? null,
      customerEmail: order.email,
      contactId,
      value: order.value,
      currency: order.currency,
      orderTime: order.orderTime,
      // Don't overwrite an existing attribution on a later (e.g. shipped) event.
      ...(campaignAttr
        ? {
            attributedCampaignId: campaignAttr.campaignId,
            attributedContactId: campaignAttr.contactId,
            attributionModel: campaignAttr.model,
          }
        : {}),
      ...(flowAttr
        ? { attributedAutomationId: flowAttr.automationId, attributedSendId: flowAttr.sendId }
        : {}),
      raw: job.payload as object,
    },
  });

  // Advance status forward only. A single atomic UPDATE … WHERE status IN
  // (<lower ranks>) means a duplicate paid/shipped is a no-op, and an
  // out-of-order paid arriving after shipped can't regress the row.
  if (lowerOrderStatuses(newStatus).length > 0) {
    await prisma.shopOrder.updateMany({
      where: {
        shopConnectionId: job.connectionId,
        externalOrderId: order.externalOrderId,
        status: { in: lowerOrderStatuses(newStatus) },
      },
      data: { status: newStatus },
    });
  }

  // ClickHouse analytics rows (orders is ReplacingMergeTree → safe to re-insert).
  await insertOrders(ch, [
    {
      account_id: job.accountId,
      shop_id: job.connectionId,
      external_order_id: order.externalOrderId,
      customer_email: order.email,
      value: order.value,
      currency: order.currency,
      order_time: toClickHouseDateTime(order.orderTime),
      attributed_campaign_id: saved.attributedCampaignId,
      attributed_contact_id: saved.attributedContactId,
      attribution_model: saved.attributionModel ?? '',
    },
  ]).catch((e) => console.error('[shop-sync] CH orders insert failed:', e));

  // The attributions side-table records the click→order path, so it only
  // applies to last-click (hard sm_mid attribution has no click event).
  if (lastClick) {
    await insertAttributions(ch, [
      {
        account_id: job.accountId,
        campaign_id: lastClick.campaignId,
        contact_id: contactId,
        click_time: lastClick.clickTime,
        order_id: order.externalOrderId,
        order_value: order.value,
        model: 'last_click_7d',
      },
    ]).catch((e) => console.error('[shop-sync] CH attributions insert failed:', e));
  }

  await touchSync(job.connectionId);

  const ctx = {
    accountId: job.accountId,
    shopConnectionId: job.connectionId,
    externalOrderId: order.externalOrderId,
    orderNo: order.orderNo,
    email: order.email,
    contactId,
    value: order.value,
    currency: order.currency,
    trackingUrl: order.trackingUrl,
    trackingNumber: order.trackingNumber,
    items: mapLineItems(job.payload),
    addressLines: mapShippingAddressLines(job.payload),
  };
  try {
    if (shipped) await triggerOrderShipped(deps, ctx);
    else await triggerOrderPaid(deps, ctx);
  } catch (e) {
    console.error('[shop-sync] automation trigger failed:', e);
  }
}

/**
 * `orders/create`: record the order as `pending` and schedule an abandoned
 * recall `delayMinutes` later. The recall fires only if the order is still
 * unpaid then (the `orders/paid` webhook flips status to 'paid'). This is the
 * shopyy substitute for a native abandoned-checkout event and avoids polling.
 */
async function handleOrderCreated(job: ShopEventJob): Promise<void> {
  const order = mapOrder(job.payload);
  if (!order) {
    console.warn(`[shop-sync] created-order payload missing id/email (store conn ${job.connectionId})`);
    return;
  }
  const contactId = await upsertContact(job.accountId, order.email);

  await prisma.shopOrder.upsert({
    where: {
      shopConnectionId_externalOrderId: {
        shopConnectionId: job.connectionId,
        externalOrderId: order.externalOrderId,
      },
    },
    create: {
      accountId: job.accountId,
      shopConnectionId: job.connectionId,
      externalOrderId: order.externalOrderId,
      orderNo: order.orderNo ?? null,
      customerEmail: order.email,
      contactId,
      value: order.value,
      currency: order.currency,
      status: 'pending',
      orderTime: order.orderTime,
      raw: job.payload as object,
    },
    // Never overwrite `status` here: a paid/shipped webhook may have raced ahead
    // and we must not downgrade a converted order back to 'pending'.
    update: {
      orderNo: order.orderNo ?? null,
      customerEmail: order.email,
      contactId,
      value: order.value,
      currency: order.currency,
      orderTime: order.orderTime,
      raw: job.payload as object,
    },
  });

  await touchSync(job.connectionId);

  try {
    await scheduleAbandonedFromOrder(deps, {
      accountId: job.accountId,
      shopConnectionId: job.connectionId,
      externalOrderId: order.externalOrderId,
      orderNo: order.orderNo,
      email: order.email,
      contactId,
      value: order.value,
      currency: order.currency,
      recoveryUrl: order.payUrl,
    });
  } catch (e) {
    console.error('[shop-sync] abandoned-from-order schedule failed:', e);
  }
}

async function handleAbandoned(job: ShopEventJob): Promise<void> {
  const checkout = mapCheckout(job.payload);
  if (!checkout) {
    console.warn(`[shop-sync] checkout payload missing id/email (store conn ${job.connectionId})`);
    return;
  }
  const contactId = await upsertContact(job.accountId, checkout.email);

  await prisma.shopAbandonedCheckout.upsert({
    where: {
      shopConnectionId_externalCheckoutId: {
        shopConnectionId: job.connectionId,
        externalCheckoutId: checkout.externalCheckoutId,
      },
    },
    create: {
      accountId: job.accountId,
      shopConnectionId: job.connectionId,
      externalCheckoutId: checkout.externalCheckoutId,
      customerEmail: checkout.email,
      contactId,
      value: checkout.value ?? null,
      currency: checkout.currency ?? null,
      recoveryUrl: checkout.recoveryUrl ?? null,
      abandonedAt: checkout.abandonedAt,
      status: 'pending',
      raw: job.payload as object,
    },
    update: {
      customerEmail: checkout.email,
      contactId,
      value: checkout.value ?? null,
      currency: checkout.currency ?? null,
      recoveryUrl: checkout.recoveryUrl ?? null,
      abandonedAt: checkout.abandonedAt,
      raw: job.payload as object,
    },
  });

  await touchSync(job.connectionId);

  try {
    await scheduleAbandonedRecovery(deps, {
      accountId: job.accountId,
      shopConnectionId: job.connectionId,
      externalCheckoutId: checkout.externalCheckoutId,
      email: checkout.email,
      contactId,
      value: checkout.value,
      currency: checkout.currency,
      recoveryUrl: checkout.recoveryUrl,
    });
  } catch (e) {
    console.error('[shop-sync] abandoned schedule failed:', e);
  }
}

async function runJob(job: Job<ShopEventJob>): Promise<void> {
  const data = job.data;
  switch (data.topic) {
    case 'order_created':
      return handleOrderCreated(data);
    case 'order_paid':
      return handleOrder(data, false);
    case 'order_shipped':
      return handleOrder(data, true);
    case 'checkout_abandoned':
      return handleAbandoned(data);
    default:
      console.warn(`[shop-sync] unknown topic ${(data as ShopEventJob).topic}`);
  }
}

new Worker<ShopEventJob>(QUEUE_NAMES.SHOP_EVENTS, runJob, {
  connection,
  concurrency: 8,
});

// Delayed abandoned-cart recovery. Jobs land here `delayMinutes` after the
// checkout was abandoned; the handler re-checks for conversion before sending.
new Worker<AbandonedJob>(
  QUEUE_NAMES.SHOP_ABANDONED,
  async (job: Job<AbandonedJob>) =>
    job.data.externalOrderId
      ? runAbandonedFromOrder(deps, job.data)
      : runAbandonedRecovery(deps, job.data),
  { connection, concurrency: 4 },
);

console.log('worker-shop-sync started');

async function shutdown() {
  console.log('Shutting down worker-shop-sync...');
  await sendQueue.close().catch(() => undefined);
  await abandonedQueue.close().catch(() => undefined);
  await ch.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
