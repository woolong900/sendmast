import type { PrismaClient, ShopAutomationType } from '@prisma/client';
import type { Queue } from 'bullmq';
import { enqueueTransactional, formatMoney } from './transactional.js';
import { mapLineItems, type LineItem } from './mapper.js';

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
  /** Raw order webhook payload, used to render the {{order_items}} list. */
  rawPayload?: Record<string, unknown>;
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

/**
 * Payload for a delayed abandoned-cart recovery job (`shop-abandoned`). Two
 * sources: checkout-based (provider abandoned-checkout event → `externalCheckoutId`)
 * and order-based (shopyy `orders/create` still unpaid → `externalOrderId`).
 * Exactly one of the two ids is set; the worker routes on `externalOrderId`.
 */
export interface AbandonedJob {
  accountId: string;
  shopConnectionId: string;
  automationId: string;
  externalCheckoutId?: string;
  externalOrderId?: string;
  orderNo?: string;
  email: string;
  contactId: string;
  value?: number;
  currency?: string;
  recoveryUrl?: string;
}

export interface OrderAbandonContext {
  accountId: string;
  shopConnectionId: string;
  externalOrderId: string;
  orderNo?: string;
  email: string;
  contactId: string;
  value: number;
  currency: string;
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
  abandoned_cart: 'Complete your purchase',
};

/** Resolve {{shop_name}} from the connected store record. */
async function shopNameMergeVar(
  prisma: PrismaClient,
  shopConnectionId: string,
): Promise<Record<string, string>> {
  const conn = await prisma.shopConnection.findUnique({
    where: { id: shopConnectionId },
    select: { shopName: true, shopDomain: true },
  });
  const name = conn?.shopName?.trim() || conn?.shopDomain?.trim() || '';
  return name ? { shop_name: name } : {};
}

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Render cart line items into an email-safe HTML fragment (one row per item:
 * thumbnail + title × qty), to inject via the `{{order_items}}` merge var.
 * Dynamic text is escaped here because worker-sender injects html-merge vars
 * verbatim. Returns '' when there are no items so the block disappears.
 * Inline styles + <table> layout for Outlook/Gmail reliability; matches the
 * default abandoned-cart template's palette.
 */
export function renderOrderItemsHtml(items: LineItem[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map((it) => {
      const title = escapeHtml(it.title);
      const qty = Math.max(1, Math.round(it.quantity));
      const variant = it.variant ? escapeHtml(it.variant) : '';
      const thumb = it.imageUrl
        ? `<img src="${escapeHtml(it.imageUrl)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:8px;border:1px solid #eceff3;object-fit:cover;">`
        : `<div style="width:56px;height:56px;border-radius:8px;border:1px solid #eceff3;background:#f1f3f5;"></div>`;
      const variantLine = variant
        ? `<div style="font-size:13px;color:#9ca3af;margin-top:3px;">${variant}</div>`
        : '';
      return `              <tr>
                <td width="72" valign="top" style="padding:14px 0;border-top:1px solid #eceff3;">${thumb}</td>
                <td valign="middle" style="padding:14px 0 14px 14px;border-top:1px solid #eceff3;font-size:16px;color:#111827;line-height:1.4;"><strong style="font-weight:600;">${title}</strong> &times; ${qty}${variantLine}</td>
              </tr>`;
    })
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse; margin:0 0 24px;">
${rows}
            </table>`;
}

function orderMergeVars(ctx: OrderContext, shopName: Record<string, string>): Record<string, string> {
  const itemsHtml = ctx.rawPayload
    ? renderOrderItemsHtml(mapLineItems(ctx.rawPayload))
    : '';
  return {
    ...shopName,
    order_no: ctx.orderNo ?? ctx.externalOrderId,
    order_total: formatMoney(ctx.value, ctx.currency),
    order_currency: ctx.currency,
    ...(ctx.trackingUrl ? { tracking_url: ctx.trackingUrl } : {}),
    ...(itemsHtml ? { order_items: itemsHtml } : {}),
  };
}

export async function triggerOrderPaid(
  deps: AutomationDeps,
  ctx: OrderContext,
): Promise<void> {
  const a = await loadAutomation(deps.prisma, ctx.shopConnectionId, 'order_paid');
  if (!a) return;
  const shopName = await shopNameMergeVar(deps.prisma, ctx.shopConnectionId);
  await enqueueTransactional(deps, {
    accountId: ctx.accountId,
    automationId: a.id,
    dedupKey: `paid:${ctx.externalOrderId}`,
    contactId: ctx.contactId,
    email: ctx.email,
    subject: a.subject,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    mergeVars: orderMergeVars(ctx, shopName),
  });
}

export async function triggerOrderShipped(
  deps: AutomationDeps,
  ctx: OrderContext,
): Promise<void> {
  const a = await loadAutomation(deps.prisma, ctx.shopConnectionId, 'order_shipped');
  if (!a) return;
  const shopName = await shopNameMergeVar(deps.prisma, ctx.shopConnectionId);
  await enqueueTransactional(deps, {
    accountId: ctx.accountId,
    automationId: a.id,
    dedupKey: `shipped:${ctx.externalOrderId}`,
    contactId: ctx.contactId,
    email: ctx.email,
    subject: a.subject,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    mergeVars: orderMergeVars(ctx, shopName),
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
  if (!a || !job.externalCheckoutId) return;

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

  const shopName = await shopNameMergeVar(deps.prisma, job.shopConnectionId);
  const mergeVars: Record<string, string> = {
    ...shopName,
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

/**
 * Schedule an order-based abandoned recall. Fired on shopyy `orders/create`:
 * the order is recorded as `pending`, then re-checked `delayMinutes` later. The
 * jobId dedupes re-delivered create webhooks to a single scheduled recall.
 */
export async function scheduleAbandonedFromOrder(
  deps: AutomationDeps,
  ctx: OrderAbandonContext,
): Promise<void> {
  const a = await loadAutomation(deps.prisma, ctx.shopConnectionId, 'abandoned_cart');
  if (!a) return;

  const job: AbandonedJob = {
    accountId: ctx.accountId,
    shopConnectionId: ctx.shopConnectionId,
    automationId: a.id,
    externalOrderId: ctx.externalOrderId,
    orderNo: ctx.orderNo,
    email: ctx.email,
    contactId: ctx.contactId,
    value: ctx.value,
    currency: ctx.currency,
    recoveryUrl: ctx.recoveryUrl,
  };
  await deps.abandonedQueue.add('recover-order', job, {
    delay: a.delayMinutes * 60_000,
    jobId: `ab-order-${ctx.shopConnectionId}-${ctx.externalOrderId}`,
    removeOnComplete: true,
    removeOnFail: { age: 86400 * 7 },
  });
}

/**
 * Fire an order-based abandoned recall unless the order has since been paid.
 * The `orders/paid` webhook canonicalises `shop_orders.status` to 'paid' (and
 * 'shipped' on fulfillment), so anything other than 'pending' means the buyer
 * converted (or the order was cancelled) → no recall. Idempotency is enforced
 * by the `ShopAutomationSend` unique key on (automationId, dedupKey).
 */
export async function runAbandonedFromOrder(
  deps: AutomationDeps,
  job: AbandonedJob,
): Promise<void> {
  const a = await loadAutomation(deps.prisma, job.shopConnectionId, 'abandoned_cart');
  if (!a || !job.externalOrderId) return;

  const order = await deps.prisma.shopOrder.findUnique({
    where: {
      shopConnectionId_externalOrderId: {
        shopConnectionId: job.shopConnectionId,
        externalOrderId: job.externalOrderId,
      },
    },
    select: { status: true, raw: true },
  });
  // Only recall while still unpaid; paid/shipped/cancelled → buyer is done.
  if (!order || order.status !== 'pending') return;

  // Render the cart product list from the stored payload (kept off the BullMQ
  // job to keep it small). Empty string when the payload has no line items.
  const itemsHtml = renderOrderItemsHtml(
    mapLineItems((order.raw ?? {}) as Record<string, unknown>),
  );

  const shopName = await shopNameMergeVar(deps.prisma, job.shopConnectionId);
  const mergeVars: Record<string, string> = {
    ...shopName,
    order_no: job.orderNo ?? job.externalOrderId,
    order_currency: job.currency ?? '',
    ...(job.value != null && job.currency
      ? { order_total: formatMoney(job.value, job.currency) }
      : {}),
    ...(job.recoveryUrl ? { tracking_url: job.recoveryUrl } : {}),
    ...(itemsHtml ? { order_items: itemsHtml } : {}),
  };

  await enqueueTransactional(deps, {
    accountId: job.accountId,
    automationId: a.id,
    dedupKey: `abandoned:order:${job.externalOrderId}`,
    contactId: job.contactId,
    email: job.email,
    subject: a.subject,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    mergeVars,
  });
}
