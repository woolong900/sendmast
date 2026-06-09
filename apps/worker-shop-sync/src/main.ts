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
import { mapCheckout, mapOrder } from './mapper.js';
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

  // Last-click attribution: only meaningful for the paid event (the conversion).
  const attribution = shipped
    ? null
    : await findLastClick(ch, {
        accountId: job.accountId,
        contactId,
        withinDays: ATTRIBUTION_WINDOW_DAYS,
      }).catch(() => null);

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
      // This handler runs for the paid/shipped events, so the status is known —
      // canonicalise it so the abandoned-order recall can reliably tell a paid
      // order from a still-pending one.
      status: shipped ? 'shipped' : 'paid',
      orderTime: order.orderTime,
      attributedCampaignId: attribution?.campaignId ?? null,
      attributedContactId: attribution ? contactId : null,
      attributionModel: attribution ? 'last_click_7d' : null,
      raw: job.payload as object,
    },
    update: {
      orderNo: order.orderNo ?? null,
      customerEmail: order.email,
      contactId,
      value: order.value,
      currency: order.currency,
      status: shipped ? 'shipped' : 'paid',
      orderTime: order.orderTime,
      // Don't overwrite an existing attribution on a later (e.g. shipped) event.
      ...(attribution
        ? {
            attributedCampaignId: attribution.campaignId,
            attributedContactId: contactId,
            attributionModel: 'last_click_7d',
          }
        : {}),
      raw: job.payload as object,
    },
  });

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

  if (attribution) {
    await insertAttributions(ch, [
      {
        account_id: job.accountId,
        campaign_id: attribution.campaignId,
        contact_id: contactId,
        click_time: attribution.clickTime,
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
