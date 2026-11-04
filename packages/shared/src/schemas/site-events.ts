import { z } from 'zod';

/**
 * Storefront behaviour events reported by the landing-page script for
 * visitors who arrived from one of our emails (identified by `sm_mid`).
 * `purchase` is additionally written server-side from order webhooks.
 */
export const SITE_EVENT_TYPES = [
  'page_view',
  'view_home',
  'view_collection',
  'view_product',
  'view_cart',
  'add_to_cart',
  'begin_checkout',
  'add_payment_info',
  'purchase',
] as const;
export const SiteEventTypeSchema = z.enum(SITE_EVENT_TYPES);
export type SiteEventType = z.infer<typeof SiteEventTypeSchema>;

export const SITE_EVENT_LABELS: Record<SiteEventType, string> = {
  page_view: '浏览任意页面',
  view_home: '浏览首页',
  view_collection: '浏览分类/集合页',
  view_product: '浏览商品详情页',
  view_cart: '查看购物车',
  add_to_cart: '加入购物车',
  begin_checkout: '发起结账',
  add_payment_info: '填写支付信息',
  purchase: '完成支付',
};

/** One event inside a beacon batch (short keys keep the payload small). */
export const SiteEventInputSchema = z.object({
  /** event type */
  t: SiteEventTypeSchema,
  /** client timestamp (ms); server clamps to a sane window */
  ts: z.number().int().positive().optional(),
  /** page URL */
  u: z.string().max(2000).optional(),
  /** product id / sku */
  p: z.string().max(200).optional(),
  /** value (cart / order amount) */
  v: z.number().min(0).max(1e10).optional(),
  /** currency */
  c: z.string().max(10).optional(),
  /** free-form extras (order number, quantity, …) */
  m: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
});
export type SiteEventInput = z.infer<typeof SiteEventInputSchema>;

/** Beacon body posted to `/t/s/e`. */
export const SiteEventBatchSchema = z.object({
  /** shop connection's public site tracking key */
  k: z.string().min(16).max(64),
  /**
   * sm_mid — campaign recipient id or flow send id (the landing URL doesn't
   * say which; the worker resolves it against both, like order attribution).
   */
  mid: z.string().uuid(),
  /** browser session id */
  sid: z.string().max(64).optional(),
  e: z.array(SiteEventInputSchema).min(1).max(20),
});
export type SiteEventBatch = z.infer<typeof SiteEventBatchSchema>;

/** Job payload on the SITE_EVENTS_INGEST queue. */
export interface SiteEventsJobData {
  shopId: string;
  accountId: string;
  mid: string;
  sid?: string;
  ip?: string;
  userAgent?: string;
  receivedAt: number;
  events: SiteEventInput[];
  origin: 'script' | 'webhook';
}

/** Install status of the storefront script for a shop connection. */
export interface SiteTrackingStatus {
  connectionId: string;
  siteKey: string;
  scriptUrl: string;
  snippet: string;
  install: 'api' | 'manual' | null;
  lastSeenAt: string | null;
  /** Whether automatic installation through the Shopyy OpenAPI is available. */
  apiInstallSupported: boolean;
}
