import { z } from 'zod';

/**
 * Shopyy (OEMSAAS) integration DTOs — the browser-safe half of the feature.
 * Node-only signing + the OpenAPI client live in `@sendmast/shopyy` so this
 * (barrel-exported, hence bundled into the web app) stays free of `node:*`.
 */

export const SHOP_PROVIDERS = ['shopyy'] as const;
export type ShopProvider = (typeof SHOP_PROVIDERS)[number];

export const SHOP_CONNECTION_STATUSES = ['active', 'expired', 'revoked'] as const;
export type ShopConnectionStatus = (typeof SHOP_CONNECTION_STATUSES)[number];

export const SHOP_AUTOMATION_TYPES = [
  'customer_registered',
  'order_paid',
  'order_shipped',
  'abandoned_cart',
] as const;
export type ShopAutomationType = (typeof SHOP_AUTOMATION_TYPES)[number];

/** Chinese labels for the fixed automations (settings UI). */
export const SHOP_AUTOMATION_LABELS: Record<ShopAutomationType, string> = {
  customer_registered: '顾客注册欢迎',
  order_paid: '订单支付通知',
  order_shipped: '订单发货通知',
  abandoned_cart: '弃单召回',
};

/**
 * Default email subject per automation, used when the merchant leaves the
 * subject blank. Shown pre-filled in the editor and used as the send-time
 * fallback (worker `DEFAULT_SUBJECT`). For abandoned_cart this is only a
 * generic fallback — per-round defaults live in `ABANDONED_CART_DEFAULT_ROUNDS`.
 */
export const SHOP_AUTOMATION_DEFAULT_SUBJECT: Record<ShopAutomationType, string> = {
  customer_registered: 'Welcome to {{shop_name}}',
  order_paid: 'Your order is confirmed',
  order_shipped: 'Your order has shipped',
  abandoned_cart: 'Did you forget something?',
};

/**
 * Default preview text (preheader) per automation. Shown pre-filled in the
 * editor and injected as the send-time fallback when left blank.
 */
export const SHOP_AUTOMATION_DEFAULT_PREHEADER: Record<ShopAutomationType, string> = {
  customer_registered: 'Thanks for joining us — we are glad you are here.',
  order_paid: 'Thanks for your order — here are the details.',
  order_shipped: 'Your package is on the way — track your delivery.',
  abandoned_cart: 'Are you still interested in these items?',
};

/**
 * Per-round default subject/preview for abandoned-cart recovery (1-based round
 * → entry). Each escalating round nudges harder. Used to pre-fill the editor
 * and as the send-time fallback when a round leaves its fields blank.
 */
export const ABANDONED_CART_DEFAULT_ROUNDS: ReadonlyArray<{
  subject: string;
  preheader: string;
}> = [
  { subject: 'Did you forget something?', preheader: 'Are you still interested in these items?' },
  { subject: 'Your items are waiting for you', preheader: 'Complete your purchase' },
  { subject: "Finish your order before it's gone!", preheader: "Let's complete your order!" },
  {
    subject: 'Items in your cart are selling out fast!',
    preheader: 'Complete your purchase',
  },
  { subject: 'Your cart misses you!', preheader: 'You still have items left in your cart' },
];

/** Resolve a 1-based recovery round's default subject/preview (clamped to range). */
export function abandonedRoundDefault(round: number): { subject: string; preheader: string } {
  const i = Math.min(Math.max(round, 1), ABANDONED_CART_DEFAULT_ROUNDS.length) - 1;
  return ABANDONED_CART_DEFAULT_ROUNDS[i]!;
}

/**
 * Body the SPA posts after shopyy redirects the merchant back to our
 * frontend callback page with `code` + `authorize_token_url`. The SPA holds
 * the logged-in JWT, so the bind happens against the current tenant.
 */
export const ConnectShopyySchema = z.object({
  code: z.string().min(1),
  authorizeTokenUrl: z.string().url(),
});
export type ConnectShopyyInput = z.infer<typeof ConnectShopyySchema>;

export interface ShopConnectionView {
  id: string;
  provider: ShopProvider;
  externalStoreId: string;
  shopName: string | null;
  shopDomain: string | null;
  mainDomain: string | null;
  storeUrl: string | null;
  status: ShopConnectionStatus;
  storeExpiredAt: string | null;
  connectedAt: string;
  lastSyncAt: string | null;
}

function validStoreUrl(value: string | null): boolean {
  if (value === null || value === '') return true;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return (
      ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export const UpdateShopConnectionSchema = z.object({
  storeUrl: z
    .string()
    .trim()
    .max(2048)
    .nullable()
    .refine(validStoreUrl, '请输入有效的店铺访问地址'),
});
export type UpdateShopConnectionInput = z.infer<typeof UpdateShopConnectionSchema>;

export type ShopConnectionHealthStatus = 'healthy' | 'degraded' | 'expired' | 'revoked';

export interface ShopConnectionHealthView {
  status: ShopConnectionHealthStatus;
  authorizationValid: boolean;
  expectedWebhookCount: number;
  installedWebhookCount: number;
  missingWebhookIds: number[];
  checkedAt: string;
  message: string | null;
}

/** Per-flow engagement rollup (Klaviyo-style flow performance). */
export interface FlowStatsView {
  /** Sends accepted by the provider (shop_automation_sends.status='sent'). */
  sent: number;
  /** Unique recipients with a delivered/open/click/bounce event (ClickHouse). */
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  /** Revenue hard-attributed to this flow (orders carrying its recall sm_mid). */
  revenue: number;
  /** Currency of `revenue` (the flow's dominant order currency). */
  currency: string;
}

/** Max recovery rounds an abandoned-cart automation can be split into. */
export const MAX_ABANDONED_ROUNDS = 5;

/** How a coupon discounts: a percentage off, or a fixed amount off. */
export type CouponDiscountKind = 'percent' | 'amount';

/** One configured recovery round (abandoned_cart only). */
export interface ShopAutomationStepView {
  id: string;
  stepIndex: number;
  /** Legacy source template; content is now inline below. */
  templateId: string | null;
  /** Inline email content for this round (sent html + editor design tree). */
  html: string | null;
  designJson: unknown | null;
  thumbnail: string | null;
  /** Optional inbox preview text (preheader). */
  preheader: string | null;
  subject: string | null;
  /** Store coupon code shown in this round's email; null = no coupon. */
  couponCode: string | null;
  /** Snapshot of the coupon's discount kind/value, for the email's "Save …" line. */
  couponDiscountKind: CouponDiscountKind | null;
  couponDiscountValue: number | null;
  delayMinutes: number;
}

/** A store coupon offered in the per-round coupon picker. */
export interface ShopCouponView {
  /** Code the buyer enters at checkout (the value we persist + render). */
  code: string;
  /** Human label for the picker (falls back to the code). */
  name: string;
  /** Discount kind, or null when the gateway didn't expose a recognised one. */
  discountKind: CouponDiscountKind | null;
  /** Discount value: percent off (kind=percent) or amount off (kind=amount). */
  discountValue: number | null;
}

export interface ShopAutomationView {
  id: string;
  type: ShopAutomationType;
  enabled: boolean;
  /** Legacy source template; content is now inline below (single-template flows). */
  templateId: string | null;
  /** Inline email content (single-template flows; abandoned_cart uses steps[]). */
  html: string | null;
  designJson: unknown | null;
  thumbnail: string | null;
  /** Optional inbox preview text (preheader). */
  preheader: string | null;
  senderDomainId: string | null;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  /** Store coupon code shown in this flow's email; null = no coupon. */
  couponCode: string | null;
  /** Snapshot of the coupon's discount kind/value, for the email's "Save …" line. */
  couponDiscountKind: CouponDiscountKind | null;
  couponDiscountValue: number | null;
  delayMinutes: number;
  /** Recovery rounds — only populated for `abandoned_cart`. */
  steps: ShopAutomationStepView[];
  /** Lifetime performance for this flow. */
  stats: FlowStatsView;
}

export const ShopAutomationSendQuerySchema = z.object({
  connectionId: z.string().uuid().optional(),
  automationType: z.enum(SHOP_AUTOMATION_TYPES).optional(),
  status: z.enum(['pending', 'queued', 'sent', 'failed', 'skipped']).optional(),
  email: z.string().trim().min(1).max(320).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ShopAutomationSendQuery = z.infer<typeof ShopAutomationSendQuerySchema>;

export interface ShopAutomationSendView {
  id: string;
  connectionId: string;
  shopName: string | null;
  automationId: string;
  automationType: ShopAutomationType;
  email: string;
  subject: string | null;
  status: string;
  errorMessage: string | null;
  messageId: string | null;
  orderNo: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface ShopAutomationSendListResponse {
  rows: ShopAutomationSendView[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * One recovery round in an `abandoned_cart` update. `delayMinutes` is absolute
 * (minutes after order creation); the server enforces strictly increasing
 * delays across the ordered list.
 */
export const ShopAutomationStepSchema = z.object({
  templateId: z.string().uuid().nullable().optional(),
  /** Inline email content for this round. */
  html: z.string().nullable().optional(),
  mjml: z.string().nullable().optional(),
  designJson: z.unknown().optional(),
  thumbnail: z.string().nullable().optional(),
  preheader: z.string().max(255).nullable().optional(),
  subject: z.string().max(255).nullable().optional(),
  couponCode: z.string().max(100).nullable().optional(),
  couponDiscountKind: z.enum(['percent', 'amount']).nullable().optional(),
  couponDiscountValue: z.number().nonnegative().nullable().optional(),
  delayMinutes: z.number().int().min(1).max(10080),
});
export type ShopAutomationStepInput = z.infer<typeof ShopAutomationStepSchema>;

/**
 * Editable automation fields. `delayMinutes` only meaningful for
 * `abandoned_cart` (minutes to wait after an order is created before sending
 * the recall, if still unpaid) but accepted for all to keep the form uniform.
 * `steps` replaces the recovery rounds for `abandoned_cart` (1..5, strictly
 * increasing delays); when present it supersedes the top-level
 * `templateId`/`subject`/`delayMinutes` for that type.
 */
export const UpdateShopAutomationSchema = z.object({
  enabled: z.boolean().optional(),
  templateId: z.string().uuid().nullable().optional(),
  /** Inline email content (single-template flows). */
  html: z.string().nullable().optional(),
  mjml: z.string().nullable().optional(),
  designJson: z.unknown().optional(),
  thumbnail: z.string().nullable().optional(),
  preheader: z.string().max(255).nullable().optional(),
  senderDomainId: z.string().uuid().nullable().optional(),
  fromEmail: z.string().email().nullable().optional(),
  fromName: z.string().max(100).nullable().optional(),
  subject: z.string().max(255).nullable().optional(),
  couponCode: z.string().max(100).nullable().optional(),
  couponDiscountKind: z.enum(['percent', 'amount']).nullable().optional(),
  couponDiscountValue: z.number().nonnegative().nullable().optional(),
  delayMinutes: z.number().int().min(1).max(10080).optional(),
  steps: z
    .array(ShopAutomationStepSchema)
    .min(1)
    .max(MAX_ABANDONED_ROUNDS)
    .refine(
      (steps) => steps.every((s, i) => i === 0 || s.delayMinutes > steps[i - 1]!.delayMinutes),
      { message: '每一轮的延迟必须大于前一轮' },
    )
    .optional(),
});
export type UpdateShopAutomationInput = z.infer<typeof UpdateShopAutomationSchema>;

/**
 * Normalised inbound topics. shopyy's raw topic strings vary
 * (`order.paid` / `orders/paid` / `order_paid` ...) so the webhook normalises
 * to these before enqueueing. `order_created` is how we drive abandoned-cart
 * recovery on shopyy (which has no native abandoned-checkout event): every
 * created order is recorded, then re-checked `delayMinutes` later — if still
 * unpaid, the recall fires.
 */
export type ShopEventTopic =
  | 'order_paid'
  | 'order_shipped'
  | 'checkout_abandoned'
  | 'order_created'
  | 'customer_created';

/** Map a raw provider topic string to our normalised topic (null = ignore). */
export function normalizeShopTopic(raw: string | undefined | null): ShopEventTopic | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[\s./-]+/g, '_');
  // `customers/create` — the only customer event we subscribe to.
  if (t.includes('customer')) return 'customer_created';
  if (t.includes('paid') || t.includes('pay')) return 'order_paid';
  if (t.includes('ship') || t.includes('fulfill') || t.includes('deliver')) return 'order_shipped';
  if (t.includes('abandon') || t.includes('checkout')) return 'checkout_abandoned';
  // `orders/create` + `orderonepeges/create` (single-page flow).
  if (t.includes('create') && (t.includes('order') || t.includes('peg'))) return 'order_created';
  return null;
}

/** BullMQ job payload for the `shop-events` queue (webhook -> worker). */
export interface ShopEventJob {
  connectionId: string;
  accountId: string;
  topic: ShopEventTopic;
  payload: Record<string, unknown>;
  receivedAt: string;
}

/**
 * BullMQ job payload for the `shop-sync` queue. Enqueued once per successful
 * store bind: worker-shop-sync pages the store's full customer base into the
 * connection's 店铺客户 list and backfills all paid orders into shop_orders.
 */
export interface ShopSyncJob {
  connectionId: string;
  accountId: string;
}

/** Sales rollup for a campaign / dashboard (revenue attributed to email). */
export interface SalesSummary {
  orders: number;
  revenue: number;
  currency: string;
  /** Average order value = revenue / orders (0 when no orders). */
  aov: number;
}
