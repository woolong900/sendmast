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
  'order_paid',
  'order_shipped',
  'abandoned_cart',
] as const;
export type ShopAutomationType = (typeof SHOP_AUTOMATION_TYPES)[number];

/** Chinese labels for the three fixed automations (settings UI). */
export const SHOP_AUTOMATION_LABELS: Record<ShopAutomationType, string> = {
  order_paid: '订单支付通知',
  order_shipped: '订单发货通知',
  abandoned_cart: '弃单召回',
};

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
  status: ShopConnectionStatus;
  storeExpiredAt: string | null;
  connectedAt: string;
  lastSyncAt: string | null;
}

/** Per-flow engagement rollup (Klaviyo-style flow performance). */
export interface FlowStatsView {
  /** Sends accepted by ACS (shop_automation_sends.status='sent'). */
  sent: number;
  /** Unique recipients with a delivered/open/click/bounce event (ClickHouse). */
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
}

export interface ShopAutomationView {
  id: string;
  type: ShopAutomationType;
  enabled: boolean;
  templateId: string | null;
  senderDomainId: string | null;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  delayMinutes: number;
  /** Lifetime performance for this flow. */
  stats: FlowStatsView;
}

/**
 * Editable automation fields. `delayMinutes` only meaningful for
 * `abandoned_cart` but accepted for all to keep the form uniform.
 */
export const UpdateShopAutomationSchema = z.object({
  enabled: z.boolean().optional(),
  templateId: z.string().uuid().nullable().optional(),
  senderDomainId: z.string().uuid().nullable().optional(),
  fromEmail: z.string().email().nullable().optional(),
  fromName: z.string().max(100).nullable().optional(),
  subject: z.string().max(255).nullable().optional(),
  delayMinutes: z.number().int().min(5).max(10080).optional(),
});
export type UpdateShopAutomationInput = z.infer<typeof UpdateShopAutomationSchema>;

/**
 * Normalised inbound topics. shopyy's raw topic strings vary
 * (`order.paid` / `orders/paid` / `order_paid` ...) so the webhook normalises
 * to these before enqueueing.
 */
export type ShopEventTopic = 'order_paid' | 'order_shipped' | 'checkout_abandoned';

/** Map a raw provider topic string to our normalised topic (null = ignore). */
export function normalizeShopTopic(raw: string | undefined | null): ShopEventTopic | null {
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/[\s./-]+/g, '_');
  if (t.includes('paid') || t.includes('pay')) return 'order_paid';
  if (t.includes('ship') || t.includes('fulfill') || t.includes('deliver'))
    return 'order_shipped';
  if (t.includes('abandon') || t.includes('checkout')) return 'checkout_abandoned';
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

/** Sales rollup for a campaign / dashboard (revenue attributed to email). */
export interface SalesSummary {
  orders: number;
  revenue: number;
  currency: string;
  /** Average order value = revenue / orders (0 when no orders). */
  aov: number;
}
