/**
 * Shapes returned by the shopyy authorize-token exchange and OpenAPI gateway.
 *
 * The authorize exchange shape is confirmed from the 语雀 doc. OpenAPI order /
 * checkout payloads are NOT yet pinned down (the apizza spec is a JS SPA we
 * couldn't scrape), so those carry a permissive index signature and the
 * concrete field reads live in the webhook field-mapper — change them there
 * once the catalogue is available without touching transport code.
 */

export interface ShopyyStore {
  id: string | number;
  shop_name?: string;
  shop_domain?: string;
  main_domain?: string;
  brand_id?: string | number;
  time_zone?: string;
  /** Unix seconds or ISO — callers normalise. */
  expired_at?: string | number;
}

export interface ShopyyDeveloperApp {
  name?: string;
  /** Token used as the credential for every OpenAPI call. */
  token: string;
  /** e.g. `https://openapi.oemsaas.shop`; persisted per-connection. */
  openapi_domain: string;
  webhook_baseurl?: string;
}

export interface ShopyyApp {
  id: string | number;
  name?: string;
  key?: string;
}

export interface ShopyyUser {
  id: string | number;
  name?: string;
}

/** Decoded `data` from the authorize-token exchange. */
export interface ShopyyAuthorizeResult {
  store: ShopyyStore;
  developer_app: ShopyyDeveloperApp;
  app: ShopyyApp;
  user: ShopyyUser;
}

/** Unified OpenAPI response envelope. */
export interface ShopyyEnvelope<T = unknown> {
  code: number | string;
  msg?: string;
  data?: T;
  trace_id?: string;
}

/** Permissive order/checkout payloads — mapped in worker-shop-sync. */
export type ShopyyRawOrder = Record<string, unknown>;
export type ShopyyRawCheckout = Record<string, unknown>;
