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
  /** Logistics tracking number, present on shipped orders. */
  trackingNumber?: string;
  /** Order line items, rendered into the `{{order_items}}` merge var. */
  items?: LineItem[];
  /** Shipping address as plain-text lines, rendered into `{{shipping_address}}`. */
  addressLines?: string[];
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
  /** Recovery round (1-based). Absent on the legacy single-round checkout path. */
  round?: number;
  /** Round's template, snapshotted at schedule time (multi-round abandoned). */
  templateId?: string | null;
  /** Round's subject, snapshotted at schedule time. */
  subject?: string | null;
  /** Round's coupon code, snapshotted at schedule time; rendered into the email. */
  couponCode?: string | null;
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
  order_paid: 'Your order is confirmed',
  order_shipped: 'Your order has shipped',
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

/**
 * Render the shipping address lines into an email-safe HTML fragment (one line
 * per row, joined by <br>). Dynamic text is escaped because worker-sender
 * injects html-merge vars verbatim. Returns '' when there's no address.
 */
export function renderShippingAddressHtml(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.map((l) => escapeHtml(l)).join('<br>');
}

/**
 * Render the abandoned-cart coupon card into the `{{coupon_block}}` merge var.
 * Returns '' when the round has no coupon so the block disappears. Markup +
 * palette mirror the approved style (dashed amber card, monospace code).
 */
export function renderCouponHtml(code: string | null | undefined): string {
  const c = (code ?? '').trim();
  if (!c) return '';
  const safe = escapeHtml(c);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0;border-collapse:collapse;margin:0;">
  <tr><td align="center" style="padding:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-spacing:0;border-collapse:separate;background:#fff7ed;border:2px dashed #f59e0b;border-radius:12px;">
      <tr><td align="center" style="padding:22px 24px;">
        <div style="font-size:14px;color:#92400e;font-weight:600;margin:0 0 12px;">A discount just for you</div>
        <div style="display:inline-block;background:#ffffff;border:1px dashed #f59e0b;border-radius:8px;padding:11px 24px;font-size:24px;font-weight:700;letter-spacing:3px;color:#111827;font-family:'Courier New',Courier,monospace;">${safe}</div>
        <div style="font-size:12px;color:#b45309;margin:12px 0 0;">Apply this code at checkout</div>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

function orderMergeVars(ctx: OrderContext, shopName: Record<string, string>): Record<string, string> {
  const itemsHtml = renderOrderItemsHtml(ctx.items ?? []);
  const addressHtml = renderShippingAddressHtml(ctx.addressLines ?? []);
  return {
    ...shopName,
    order_no: ctx.orderNo ?? ctx.externalOrderId,
    order_total: formatMoney(ctx.value, ctx.currency),
    order_currency: ctx.currency,
    ...(ctx.trackingUrl ? { tracking_url: ctx.trackingUrl } : {}),
    ...(ctx.trackingNumber ? { tracking_number: ctx.trackingNumber } : {}),
    ...(itemsHtml ? { order_items: itemsHtml } : {}),
    ...(addressHtml ? { shipping_address: addressHtml } : {}),
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
  const a = await deps.prisma.shopAutomation.findUnique({
    where: {
      shopConnectionId_type: {
        shopConnectionId: ctx.shopConnectionId,
        type: 'abandoned_cart',
      },
    },
  });
  if (!a || !a.enabled || !a.fromEmail) return;

  // Each configured round becomes its own delayed job (jobId carries the round
  // so they don't collide and re-delivered create webhooks stay deduped). Falls
  // back to the parent's single config when no step rows exist (pre-migration).
  const steps = await deps.prisma.shopAutomationStep.findMany({
    where: { automationId: a.id },
    orderBy: { stepIndex: 'asc' },
  });
  const rounds = steps.length
    ? steps
    : [{ stepIndex: 1, templateId: a.templateId, subject: a.subject, couponCode: null, delayMinutes: a.delayMinutes }];

  for (const s of rounds) {
    if (!s.templateId) continue; // round not configured → nothing to send
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
      round: s.stepIndex,
      templateId: s.templateId,
      subject: s.subject,
      couponCode: s.couponCode,
    };
    await deps.abandonedQueue.add('recover-order', job, {
      delay: s.delayMinutes * 60_000,
      jobId: `ab-order-${ctx.shopConnectionId}-${ctx.externalOrderId}-r${s.stepIndex}`,
      removeOnComplete: true,
      removeOnFail: { age: 86400 * 7 },
    });
  }
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
  if (!job.externalOrderId) return;
  const a = await deps.prisma.shopAutomation.findUnique({ where: { id: job.automationId } });
  if (!a || !a.enabled || !a.fromEmail) return;
  // Round template snapshotted at schedule time; fall back to the parent's.
  const templateId = job.templateId ?? a.templateId;
  if (!templateId) return;

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
    ...(job.couponCode ? { coupon_block: renderCouponHtml(job.couponCode) } : {}),
  };

  const round = job.round ?? 1;
  const fromName = a.fromName ?? a.fromEmail.split('@')[0] ?? 'Store';
  const subject = job.subject?.trim() || a.subject?.trim() || DEFAULT_SUBJECT.abandoned_cart;

  await enqueueTransactional(deps, {
    accountId: job.accountId,
    automationId: a.id,
    // Per-round dedup so each round sends once per order (idempotent on retry).
    dedupKey: `abandoned:order:${job.externalOrderId}:r${round}`,
    contactId: job.contactId,
    email: job.email,
    subject,
    fromEmail: a.fromEmail,
    fromName,
    templateId,
    mergeVars,
  });
}
