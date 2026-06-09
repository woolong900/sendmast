import type { PrismaClient, ShopAutomationType } from '@prisma/client';
import type { Queue } from 'bullmq';
import { enqueueTransactional, formatMoney } from './transactional.js';

/**
 * Automation triggers. order_paid / order_shipped fire an immediate
 * transactional send; abandoned_cart schedules a delayed recovery on the
 * `shop-abandoned` queue (handled in main.ts) which re-checks for conversion
 * before sending. All are best-effort — callers wrap them in try/catch so a
 * failure here never fails order/checkout ingestion.
 */

export interface AutomationDeps {
  prisma: PrismaClient;
  /** Queue handle for the transactional `send-email` path (phase 3). */
  sendQueue: Queue;
  /** Queue handle for delayed abandoned-cart recovery (`shop-abandoned`). */
  abandonedQueue: Queue;
}

export interface OrderContext {
  accountId: string;
  shopConnectionId: string;
  externalOrderId: string;
  orderNo?: string;
  email: string;
  contactId: string;
  value: number;
  currency: string;
  trackingUrl?: string;
}

export interface CheckoutContext {
  accountId: string;
  shopConnectionId: string;
  externalCheckoutId: string;
  email: string;
  contactId: string;
  value?: number;
  currency?: string;
  recoveryUrl?: string;
}

/** Payload for a delayed abandoned-cart recovery job (`shop-abandoned`). */
export interface AbandonedJob {
  accountId: string;
  shopConnectionId: string;
  automationId: string;
  externalCheckoutId: string;
  email: string;
  contactId: string;
  value?: number;
  currency?: string;
  recoveryUrl?: string;
}

interface ResolvedAutomation {
  id: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  html: string;
  delayMinutes: number;
}

const DEFAULT_SUBJECT: Record<ShopAutomationType, string> = {
  order_paid: '您的订单已支付成功',
  order_shipped: '您的订单已发货',
  abandoned_cart: '您的购物车还在等您',
};

/**
 * Load a configured + enabled automation and its template body. Returns null
 * when the automation is disabled, unconfigured (no template / from-address),
 * or the template was deleted — caller silently skips in all cases.
 */
async function loadAutomation(
  prisma: PrismaClient,
  shopConnectionId: string,
  type: ShopAutomationType,
): Promise<ResolvedAutomation | null> {
  const a = await prisma.shopAutomation.findUnique({
    where: { shopConnectionId_type: { shopConnectionId, type } },
  });
  if (!a || !a.enabled || !a.templateId || !a.fromEmail) return null;

  const tpl = await prisma.emailTemplate.findUnique({
    where: { id: a.templateId },
    select: { html: true },
  });
  if (!tpl?.html) return null;

  return {
    id: a.id,
    fromEmail: a.fromEmail,
    fromName: a.fromName ?? a.fromEmail.split('@')[0] ?? 'Store',
    subject: a.subject?.trim() || DEFAULT_SUBJECT[type],
    html: tpl.html,
    delayMinutes: a.delayMinutes,
  };
}

function orderMergeVars(ctx: OrderContext): Record<string, string> {
  return {
    order_no: ctx.orderNo ?? ctx.externalOrderId,
    order_total: formatMoney(ctx.value, ctx.currency),
    order_currency: ctx.currency,
    ...(ctx.trackingUrl ? { tracking_url: ctx.trackingUrl } : {}),
  };
}

export async function triggerOrderPaid(
  deps: AutomationDeps,
  ctx: OrderContext,
): Promise<void> {
  const a = await loadAutomation(deps.prisma, ctx.shopConnectionId, 'order_paid');
  if (!a) return;
  await enqueueTransactional(deps, {
    accountId: ctx.accountId,
    automationId: a.id,
    dedupKey: `paid:${ctx.externalOrderId}`,
    contactId: ctx.contactId,
    email: ctx.email,
    subject: a.subject,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    mergeVars: orderMergeVars(ctx),
  });
}

export async function triggerOrderShipped(
  deps: AutomationDeps,
  ctx: OrderContext,
): Promise<void> {
  const a = await loadAutomation(deps.prisma, ctx.shopConnectionId, 'order_shipped');
  if (!a) return;
  await enqueueTransactional(deps, {
    accountId: ctx.accountId,
    automationId: a.id,
    dedupKey: `shipped:${ctx.externalOrderId}`,
    contactId: ctx.contactId,
    email: ctx.email,
    subject: a.subject,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    mergeVars: orderMergeVars(ctx),
  });
}

export async function scheduleAbandonedRecovery(
  deps: AutomationDeps,
  ctx: CheckoutContext,
): Promise<void> {
  const a = await loadAutomation(deps.prisma, ctx.shopConnectionId, 'abandoned_cart');
  if (!a) return;

  const job: AbandonedJob = {
    accountId: ctx.accountId,
    shopConnectionId: ctx.shopConnectionId,
    automationId: a.id,
    externalCheckoutId: ctx.externalCheckoutId,
    email: ctx.email,
    contactId: ctx.contactId,
    value: ctx.value,
    currency: ctx.currency,
    recoveryUrl: ctx.recoveryUrl,
  };
  // Delay until delayMinutes after abandonment. jobId dedupes re-delivered
  // checkout webhooks to a single scheduled recovery per checkout.
  await deps.abandonedQueue.add('recover', job, {
    delay: a.delayMinutes * 60_000,
    jobId: `ab-${ctx.shopConnectionId}-${ctx.externalCheckoutId}`,
    removeOnComplete: true,
    removeOnFail: { age: 86400 * 7 },
  });
}

/**
 * Fire a scheduled abandoned-cart recovery, unless the buyer already converted.
 * Conversion check: any shop_order for this contact (or email) created at/after
 * the checkout was abandoned. Idempotency is enforced downstream by the
 * `ShopAutomationSend` unique key on (automationId, dedupKey).
 */
export async function runAbandonedRecovery(
  deps: AutomationDeps,
  job: AbandonedJob,
): Promise<void> {
  const a = await loadAutomation(deps.prisma, job.shopConnectionId, 'abandoned_cart');
  if (!a) return;

  const checkout = await deps.prisma.shopAbandonedCheckout.findUnique({
    where: {
      shopConnectionId_externalCheckoutId: {
        shopConnectionId: job.shopConnectionId,
        externalCheckoutId: job.externalCheckoutId,
      },
    },
    select: { status: true, abandonedAt: true, recoveredAt: true },
  });
  if (!checkout || checkout.status === 'recovered' || checkout.recoveredAt) return;

  // Skip if the buyer purchased after abandoning (conversion).
  const converted = await deps.prisma.shopOrder.findFirst({
    where: {
      accountId: job.accountId,
      customerEmail: job.email,
      orderTime: { gte: checkout.abandonedAt },
    },
    select: { id: true },
  });
  if (converted) {
    await deps.prisma.shopAbandonedCheckout.updateMany({
      where: {
        shopConnectionId: job.shopConnectionId,
        externalCheckoutId: job.externalCheckoutId,
      },
      data: { status: 'recovered', recoveredAt: new Date() },
    });
    return;
  }

  const mergeVars: Record<string, string> = {
    order_no: job.externalCheckoutId,
    order_currency: job.currency ?? '',
    ...(job.value != null && job.currency
      ? { order_total: formatMoney(job.value, job.currency) }
      : {}),
    ...(job.recoveryUrl ? { tracking_url: job.recoveryUrl } : {}),
  };

  const recipientId = await enqueueTransactional(deps, {
    accountId: job.accountId,
    automationId: a.id,
    dedupKey: `abandoned:${job.externalCheckoutId}`,
    contactId: job.contactId,
    email: job.email,
    subject: a.subject,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    mergeVars,
  });

  if (recipientId) {
    await deps.prisma.shopAbandonedCheckout.updateMany({
      where: {
        shopConnectionId: job.shopConnectionId,
        externalCheckoutId: job.externalCheckoutId,
      },
      data: { status: 'recovery_sent', recoveryEmailSentAt: new Date() },
    });
  }
}
