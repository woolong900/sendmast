/**
 * Field-mapper / adapter layer.
 *
 * The exact shopyy webhook payload shapes weren't available at build time
 * (the apizza catalogue is a JS SPA), so this module reads from a set of
 * candidate field names covering the common e-commerce conventions
 * (Shopify-style, snake_case, nested `order`/`checkout`). When the real
 * catalogue lands, adjust ONLY the candidate lists here — nothing downstream
 * reads raw payload fields.
 */

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

/** Resolve the order/checkout sub-object whether payload wraps it or is it. */
function unwrap(payload: Json, keys: string[]): Json {
  for (const k of keys) {
    const sub = asObject(payload[k]);
    if (sub) return sub;
  }
  return payload;
}

function pickStr(obj: Json, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function pickNum(obj: Json, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  }
  return undefined;
}

/** Pull an email from common locations incl. a nested customer object. */
function pickEmail(obj: Json): string | undefined {
  const direct = pickStr(obj, ['email', 'customer_email', 'customerEmail', 'buyer_email', 'contact_email']);
  if (direct) return direct.toLowerCase();
  const customer = asObject(obj.customer) ?? asObject(obj.buyer) ?? asObject(obj.contact);
  if (customer) {
    const e = pickStr(customer, ['email', 'mail', 'email_address']);
    if (e) return e.toLowerCase();
  }
  return undefined;
}

function pickDate(obj: Json, keys: string[]): Date {
  const raw = pickStr(obj, keys);
  if (raw) {
    const n = Number(raw);
    const d = !Number.isNaN(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export interface NormalizedOrder {
  externalOrderId: string;
  orderNo?: string;
  email: string;
  value: number;
  currency: string;
  status: string;
  orderTime: Date;
  /** Logistics tracking URL, when present on a shipped/fulfilled payload. */
  trackingUrl?: string;
}

/** Tracking URL can live on the order or a nested fulfillment/shipment object. */
function pickTrackingUrl(o: Json): string | undefined {
  const keys = ['tracking_url', 'trackingUrl', 'track_url', 'logistics_url', 'shipping_url'];
  const direct = pickStr(o, keys);
  if (direct) return direct;
  const sub =
    asObject(o.fulfillment) ??
    asObject(o.shipment) ??
    asObject(o.logistics) ??
    asObject(o.shipping);
  return sub ? pickStr(sub, [...keys, 'url']) : undefined;
}

export function mapOrder(payload: Json): NormalizedOrder | null {
  const o = unwrap(payload, ['order', 'data', 'resource']);
  const externalOrderId =
    pickStr(o, ['id', 'order_id', 'orderId', 'order_no', 'orderNo', 'sn', 'order_sn']);
  const email = pickEmail(o) ?? pickEmail(payload);
  if (!externalOrderId || !email) return null;
  return {
    externalOrderId,
    orderNo: pickStr(o, ['order_no', 'orderNo', 'order_sn', 'sn', 'number', 'name']),
    email,
    value:
      pickNum(o, [
        'total_price',
        'totalPrice',
        'total',
        'total_amount',
        'totalAmount',
        'amount',
        'grand_total',
        'paid_amount',
      ]) ?? 0,
    currency: pickStr(o, ['currency', 'currency_code', 'currencyCode']) ?? 'USD',
    status: pickStr(o, ['status', 'financial_status', 'order_status', 'state']) ?? 'paid',
    orderTime: pickDate(o, [
      'paid_at',
      'paidAt',
      'created_at',
      'createdAt',
      'order_time',
      'orderTime',
      'updated_at',
    ]),
    trackingUrl: pickTrackingUrl(o),
  };
}

export interface NormalizedCheckout {
  externalCheckoutId: string;
  email: string;
  value?: number;
  currency?: string;
  recoveryUrl?: string;
  abandonedAt: Date;
}

export function mapCheckout(payload: Json): NormalizedCheckout | null {
  const c = unwrap(payload, ['checkout', 'cart', 'data', 'resource']);
  const externalCheckoutId = pickStr(c, [
    'id',
    'checkout_id',
    'checkoutId',
    'token',
    'cart_id',
    'cartId',
  ]);
  const email = pickEmail(c) ?? pickEmail(payload);
  if (!externalCheckoutId || !email) return null;
  return {
    externalCheckoutId,
    email,
    value: pickNum(c, ['total_price', 'totalPrice', 'total', 'amount', 'subtotal']),
    currency: pickStr(c, ['currency', 'currency_code', 'currencyCode']) ?? undefined,
    recoveryUrl: pickStr(c, ['abandoned_checkout_url', 'recovery_url', 'recoveryUrl', 'url', 'checkout_url']),
    abandonedAt: pickDate(c, ['updated_at', 'updatedAt', 'created_at', 'createdAt', 'abandoned_at']),
  };
}
