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

function pickPositiveDate(obj: Json, keys: string[]): Date | undefined {
  for (const k of keys) {
    const raw = obj[k];
    if (raw == null) continue;
    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (text === '') continue;
    const n = Number(text);
    const d =
      !Number.isNaN(n) && n > 0
        ? new Date(n < 1e12 ? n * 1000 : n)
        : typeof text === 'string'
          ? new Date(text)
          : undefined;
    if (d && !Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function pickOrderTime(o: Json): Date {
  // Shopyy paid events carry `pay_at` as the actual conversion timestamp.
  // Unpaid create events report `pay_at=0`, so fall back to create/order time.
  return (
    pickPositiveDate(o, ['pay_at', 'paid_at', 'paidAt']) ??
    pickDate(o, ['created_at', 'createdAt', 'order_time', 'orderTime', 'updated_at'])
  );
}

export interface NormalizedOrder {
  externalOrderId: string;
  orderNo?: string;
  email: string;
  value: number;
  currency: string;
  status: string;
  orderTime: Date;
  /** Buyer's given name, when present — used to populate the contact's name. */
  firstName?: string;
  /** Buyer's family name, when present. */
  lastName?: string;
  /** Logistics tracking URL, when present on a shipped/fulfilled payload. */
  trackingUrl?: string;
  /** Logistics tracking number, when present on a shipped/fulfilled payload. */
  trackingNumber?: string;
  /** Pay-now / view-order URL, used by the abandoned-order recall email. */
  payUrl?: string;
  /** Storefront page the buyer landed on before ordering. */
  landingPage?: string;
  /** Storefront domain carried by the order payload. */
  shopDomain?: string;
  /** Checkout token used to build the order thank-you page URL. */
  checkoutToken?: string;
}

/** Split a single full-name string into first + (remaining) last name. */
function splitFullName(full: string): { firstName?: string; lastName?: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Pull the buyer's first/last name from an order/checkout payload. Prefers
 * explicit first_name/last_name (on the order, shipping address, or customer
 * object); falls back to splitting a single full-name string. Used to set the
 * contact's name so `{{full_name}}`/`{{first_name}}` render the real recipient
 * instead of the email local-part fallback. Note: the bare `name` key is only
 * read off the address/customer objects (on the order itself it's the order no).
 */
export function mapBuyerName(payload: Json): { firstName?: string; lastName?: string } {
  const o = unwrap(payload, ['order', 'checkout', 'cart', 'data', 'resource']);
  const address =
    asObject(o.shipping_address) ??
    asObject(o.shippingAddress) ??
    asObject(o.address) ??
    asObject(o.delivery_address) ??
    asObject(o.consignee) ??
    asObject(o.receiver) ??
    // `GET /orders` rows carry the buyer name on billing_address (verified live).
    asObject(o.billing_address);
  const customer = asObject(o.customer) ?? asObject(o.buyer) ?? asObject(o.contact);

  for (const c of [o, address, customer]) {
    if (!c) continue;
    const firstName = pickStr(c, ['first_name', 'firstName', 'given_name', 'givenName']);
    const lastName = pickStr(c, ['last_name', 'lastName', 'family_name', 'familyName', 'surname']);
    if (firstName || lastName) return { firstName, lastName };
  }
  for (const c of [address, customer]) {
    if (!c) continue;
    const full = pickStr(c, ['name', 'full_name', 'fullName', 'consignee', 'receiver', 'recipient', 'contact_name']);
    if (full) return splitFullName(full);
  }
  const customerName = pickStr(o, ['customer_name', 'customerName', 'buyer_name']);
  return customerName ? splitFullName(customerName) : {};
}

const TRACKING_NUMBER_KEYS = [
  'tracking_number',
  'trackingNumber',
  'tracking_no',
  'trackingNo',
  'track_number',
  'waybill',
  'waybill_no',
  'logistics_no',
  'express_no',
  'shipment_number',
];

/**
 * Resolve the relevant shipment object. Shopyy nests tracking inside a
 * `fulfillments` array (one entry per shipment); we use the most recent one.
 * Falls back to the singular `fulfillment`/`shipment`/... objects other
 * platforms use.
 */
function pickFulfillment(o: Json): Json | undefined {
  const arr = Array.isArray(o.fulfillments)
    ? o.fulfillments
    : Array.isArray(o.shipments)
      ? o.shipments
      : undefined;
  if (arr && arr.length) {
    const last = asObject(arr[arr.length - 1]);
    if (last) return last;
  }
  return (
    asObject(o.fulfillment) ??
    asObject(o.shipment) ??
    asObject(o.logistics) ??
    asObject(o.shipping)
  );
}

/** Tracking URL can live on the order or a nested fulfillment/shipment object. */
function pickTrackingUrl(o: Json): string | undefined {
  const keys = ['tracking_url', 'trackingUrl', 'track_url', 'logistics_url', 'shipping_url'];
  const direct = pickStr(o, keys);
  if (direct) return direct;
  const sub = pickFulfillment(o);
  if (!sub) return undefined;
  const fromSub = pickStr(sub, [...keys, 'url']);
  if (fromSub) return fromSub;
  // Shopyy embeds the carrier-tracking link inside the fulfillment `note`.
  const note = pickStr(sub, ['note', 'remark', 'memo', 'message']);
  const urlInNote = note?.match(/https?:\/\/\S+/)?.[0];
  if (urlInNote) return urlInNote;
  // Last resort: a universal 17track lookup built from the tracking number.
  const num = pickStr(sub, [...TRACKING_NUMBER_KEYS, 'number', 'no']);
  return num ? `https://t.17track.net/en#nums=${encodeURIComponent(num)}` : undefined;
}

/** Tracking number — same nesting story as the tracking URL. */
function pickTrackingNumber(o: Json): string | undefined {
  const direct = pickStr(o, TRACKING_NUMBER_KEYS);
  if (direct) return direct;
  const sub = pickFulfillment(o);
  return sub ? pickStr(sub, [...TRACKING_NUMBER_KEYS, 'number', 'no']) : undefined;
}

/**
 * Resolve the checkout-recovery URL for the abandoned-cart recall button.
 *
 * Shopyy's `orders/create` payload has no ready-made recovery link, but the
 * storefront resolves a checkout from its token at:
 *   https://{domain}/{id}-{token[:6]}/{one-page-checkouts|checkouts}/{token}
 * The leading "{id}-{token6}" segment is a cosmetic slug (only the trailing
 * token is matched server-side) but the route 404s without *some* first
 * segment, so we keep Shopyy's own shape. The path depends on `checkout_type`
 * (`one_page` → one-page-checkouts, else → checkouts). We pre-apply the cart's
 * coupon via `?email_coupon_code` so the recovered checkout keeps its discount.
 */
function pickRecoveryUrl(o: Json): string | undefined {
  // An explicit pay/checkout URL wins if a payload ever carries one.
  const explicit = pickStr(o, [
    'pay_url',
    'payment_url',
    'cashier_url',
    'checkout_url',
    'order_url',
    'detail_url',
  ]);
  if (explicit) return explicit;

  const domain = pickStr(o, ['domain', 'shop_domain', 'shopDomain', 'store_domain']);
  const token = pickStr(o, ['checkout_token', 'checkoutToken', 'token']);
  if (!domain || !token) return undefined;

  const host = domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const id = pickStr(o, ['id', 'order_id', 'orderId']) ?? token.slice(0, 6);
  const type = pickStr(o, ['checkout_type', 'checkoutType']) ?? '';
  const path = /one/i.test(type) ? 'one-page-checkouts' : 'checkouts';
  const base = `https://${host}/${id}-${token.slice(0, 6)}/${path}/${token}`;

  const couponObj = asObject(o.coupon);
  const coupon =
    pickStr(o, ['coupon_code', 'couponCode']) ??
    (couponObj ? pickStr(couponObj, ['coupon_code', 'code']) : undefined);
  return coupon ? `${base}?email_coupon_code=${encodeURIComponent(coupon)}` : base;
}

/**
 * Extract the shipping address as plain-text lines (name / street / city,
 * province, zip / country / phone). Reads candidate field names like the rest
 * of the mapper; returns [] when no address object is present. The caller
 * (automations) escapes + joins these into an HTML fragment.
 */
function mapAddressLines(addr: Json | undefined): string[] {
  if (!addr) return [];
  const name = pickStr(addr, ['name', 'full_name', 'fullName', 'consignee', 'receiver', 'contact_name', 'recipient']);
  const line1 = pickStr(addr, ['address1', 'address_1', 'address', 'addr', 'street', 'detail', 'line1', 'address_line1']);
  const line2 = pickStr(addr, ['address2', 'address_2', 'line2', 'apt', 'suite', 'address_line2']);
  const city = pickStr(addr, ['city', 'town']);
  const province = pickStr(addr, ['province', 'state', 'region', 'area', 'prefecture']);
  const zip = pickStr(addr, ['zip', 'postal_code', 'postalCode', 'postcode', 'zip_code']);
  const country = pickStr(addr, ['country', 'country_name', 'countryName', 'country_code']);
  const phone = pickStr(addr, ['phone', 'tel', 'mobile', 'telephone', 'phone_number']);
  const cityLine = [city, province, zip].filter(Boolean).join(', ');
  return [name, line1, line2, cityLine, country, phone].filter(
    (l): l is string => !!l && l.length > 0,
  );
}

export function mapShippingAddressLines(payload: Json): string[] {
  const o = unwrap(payload, ['order', 'data', 'resource']);
  return mapAddressLines(
    asObject(o.shipping_address) ??
      asObject(o.shippingAddress) ??
      asObject(o.shipping) ??
      asObject(o.address) ??
      asObject(o.consignee) ??
      asObject(o.receiver) ??
      asObject(o.delivery_address),
  );
}

/** Extract the billing address, keeping it separate from the shipping address. */
export function mapBillingAddressLines(payload: Json): string[] {
  const o = unwrap(payload, ['order', 'data', 'resource']);
  return mapAddressLines(
    asObject(o.billing_address) ??
      asObject(o.billingAddress) ??
      asObject(o.billing),
  );
}

export function mapOrder(payload: Json): NormalizedOrder | null {
  const o = unwrap(payload, ['order', 'data', 'resource']);
  const externalOrderId =
    pickStr(o, ['id', 'order_id', 'orderId', 'order_no', 'orderNo', 'sn', 'order_sn']);
  const email = pickEmail(o) ?? pickEmail(payload);
  if (!externalOrderId || !email) return null;
  const buyer = mapBuyerName(payload);
  return {
    externalOrderId,
    orderNo: pickStr(o, ['order_number', 'order_no', 'orderNo', 'order_sn', 'sn', 'number', 'name']),
    email,
    firstName: buyer.firstName,
    lastName: buyer.lastName,
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
    orderTime: pickOrderTime(o),
    trackingUrl: pickTrackingUrl(o),
    trackingNumber: pickTrackingNumber(o),
    payUrl: pickRecoveryUrl(o),
    landingPage:
      pickStr(o, ['landing_page', 'landingPage']) ??
      pickStr(payload, ['landing_page', 'landingPage']),
    shopDomain: pickStr(o, ['domain', 'shop_domain', 'shopDomain', 'store_domain']),
    checkoutToken: pickStr(o, ['checkout_token', 'checkoutToken', 'token']),
  };
}

export interface LineItem {
  title: string;
  quantity: number;
  /** Variant/spec label, e.g. "Format: 1 Roll". Empty when not present. */
  variant?: string;
  /** Product image URL, when the payload carries one. */
  imageUrl?: string;
}

/**
 * Extract cart/order line items for the abandoned-cart product list. Reads the
 * shopyy `products` array (also tolerates Shopify-style `line_items` / `items`).
 * Returns [] when none are present — caller then omits the `{{order_items}}`
 * block. Adjust ONLY the candidate field names here if the payload shape moves.
 */
export function mapLineItems(payload: Json): LineItem[] {
  const o = unwrap(payload, ['order', 'checkout', 'cart', 'data', 'resource']);
  const arr = o.products ?? o.line_items ?? o.lineItems ?? o.items;
  if (!Array.isArray(arr)) return [];
  const items: LineItem[] = [];
  for (const raw of arr) {
    const it = asObject(raw);
    if (!it) continue;
    const title = pickStr(it, ['product_title', 'title', 'name', 'product_name', 'variant_title']);
    if (!title) continue;
    items.push({
      title,
      quantity: pickNum(it, ['quantity', 'qty', 'num', 'count']) ?? 1,
      variant: pickStr(it, ['sku_value', 'variant_title', 'spec', 'variant']),
      imageUrl: pickStr(it, ['src', 'image', 'image_url', 'imageUrl', 'img', 'thumbnail', 'picture']),
    });
  }
  return items;
}

/**
 * Whether an order payload represents a PAID order. Confirmed against live
 * shopyy payloads: `pay_at` is a Unix-seconds timestamp when paid and `0` when
 * not; `financial_status` is `230` paid vs `200` unpaid. Falls back to a
 * Shopify-style string match for unknown shapes.
 */
export function isPaidOrderPayload(payload: Json): boolean {
  const o = unwrap(payload, ['order', 'data', 'resource']);
  const payAt = pickNum(o, ['pay_at', 'paid_at', 'paidAt']);
  if (payAt !== undefined) return payAt > 0;
  const fin = o['financial_status'];
  if (typeof fin === 'number') return fin >= 230;
  const status = pickStr(o, ['financial_status', 'pay_status', 'status']);
  return status ? /paid/i.test(status) : false;
}

export interface NormalizedCustomer {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  /** Normalised to 'male' / 'female'; absent when the store reports 0/unknown. */
  gender?: string;
  /** English country name (e.g. "China") — matches the free-form Contact.country. */
  country?: string;
  birthday?: Date;
}

/**
 * Map a `customers/create` webhook payload (or a `GET /customers/list` row —
 * shape verified live) to the contact fields we keep. Same candidate-field
 * philosophy as {@link mapOrder}. Verified row shape: `email`, `first_name` /
 * `last_name` (may be empty strings), `contact` (phone), `gender` (0 = unset,
 * 1/2 = male/female), `birthday` (Unix seconds, 0 = unset), and a nested
 * `country: { country_name, country_code2, chinese_name }`.
 */
export function mapCustomer(payload: Json): NormalizedCustomer | null {
  const c = unwrap(payload, ['customer', 'data', 'resource']);
  const email = pickEmail(c) ?? pickEmail(payload);
  if (!email) return null;

  let firstName = pickStr(c, ['first_name', 'firstName', 'given_name', 'givenName']);
  let lastName = pickStr(c, ['last_name', 'lastName', 'family_name', 'familyName', 'surname']);
  if (!firstName && !lastName) {
    const full = pickStr(c, ['name', 'full_name', 'fullName', 'customer_name', 'nickname']);
    if (full) ({ firstName, lastName } = splitFullName(full));
  }

  const countryObj = asObject(c.country);
  const country = countryObj
    ? pickStr(countryObj, ['country_name', 'chinese_name', 'country_code2'])
    : pickStr(c, ['country', 'country_name', 'country_code']);

  const genderNum = pickNum(c, ['gender']);
  const gender = genderNum === 1 ? 'male' : genderNum === 2 ? 'female' : undefined;

  const birthdayRaw = pickNum(c, ['birthday']);
  const birthday =
    birthdayRaw && birthdayRaw > 0
      ? new Date(birthdayRaw < 1e12 ? birthdayRaw * 1000 : birthdayRaw)
      : undefined;

  return {
    email,
    firstName,
    lastName,
    phone: pickStr(c, ['contact', 'phone', 'mobile', 'tel']),
    gender,
    country,
    birthday,
  };
}

export interface NormalizedCheckout {
  externalCheckoutId: string;
  email: string;
  value?: number;
  currency?: string;
  recoveryUrl?: string;
  abandonedAt: Date;
  /** Buyer's given name, when present — used to populate the contact's name. */
  firstName?: string;
  /** Buyer's family name, when present. */
  lastName?: string;
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
  const buyer = mapBuyerName(payload);
  return {
    externalCheckoutId,
    email,
    firstName: buyer.firstName,
    lastName: buyer.lastName,
    value: pickNum(c, ['total_price', 'totalPrice', 'total', 'amount', 'subtotal']),
    currency: pickStr(c, ['currency', 'currency_code', 'currencyCode']) ?? undefined,
    recoveryUrl: pickStr(c, ['abandoned_checkout_url', 'recovery_url', 'recoveryUrl', 'url', 'checkout_url']),
    abandonedAt: pickDate(c, ['updated_at', 'updatedAt', 'created_at', 'createdAt', 'abandoned_at']),
  };
}
