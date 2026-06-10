import { buildSignedQuery } from './sign.js';
import type {
  ShopyyAuthorizeResult,
  ShopyyEnvelope,
  ShopyyRawOrder,
} from './types.js';

/** Base error for any shopyy gateway failure. */
export class ShopyyError extends Error {
  constructor(
    message: string,
    public readonly code: number | string,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = 'ShopyyError';
  }
}

/**
 * Raised on `401 Token-Error`. Callers should flip the ShopConnection to
 * `expired` so the UI can prompt a re-authorize instead of silently failing.
 */
export class ShopyyAuthError extends ShopyyError {
  constructor(message: string, code: number | string, traceId?: string) {
    super(message, code, traceId);
    this.name = 'ShopyyAuthError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fixed partner User-Agent shopyy requires on every OpenAPI call (alongside the
 * `Tp-Partner-Id` credential). Not a secret — it's a partner-identifying bot UA.
 */
const PARTNER_USER_AGENT = 'OEMSAAS-OPENAPIBOT-SENDMAST';

/** Headers shopyy mandates on every OpenAPI request for partner identification. */
function partnerHeaders(partnerId: string | undefined): Record<string, string> {
  return {
    'User-Agent': PARTNER_USER_AGENT,
    ...(partnerId ? { 'Tp-Partner-Id': partnerId } : {}),
  };
}

function isOkCode(code: number | string): boolean {
  // The gateway uses `0`/`200`/`'0'`/`'success'` interchangeably across
  // endpoints; treat all as success and anything else as an error.
  return code === 0 || code === 200 || code === '0' || code === '200' || code === 'success';
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: ShopyyEnvelope }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    let body: ShopyyEnvelope;
    try {
      body = text ? (JSON.parse(text) as ShopyyEnvelope) : { code: res.status };
    } catch {
      body = { code: res.status, msg: text };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange the short-lived `code` for store + developer-app credentials.
 *
 * The merchant redirect hands us `authorize_token_url` and `code`; we issue a
 * signed GET (secret = the app secret obtained via official partnership). This
 * is the ONLY call that uses the app secret — every subsequent call uses the
 * returned developer-app `token`.
 */
export async function exchangeAuthorizeToken(opts: {
  authorizeTokenUrl: string;
  code: string;
  secret: string;
  /** Partner credential sent as `Tp-Partner-Id` (required by shopyy). */
  partnerId?: string;
  /** Extra params some tenants' gateways require (e.g. app key). */
  extraParams?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ShopyyAuthorizeResult> {
  const query = buildSignedQuery(
    { code: opts.code, ...(opts.extraParams ?? {}) },
    opts.secret,
  );
  const url = new URL(opts.authorizeTokenUrl);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const { status, body } = await fetchJson(
    url.toString(),
    { method: 'GET', headers: { Accept: 'application/json', ...partnerHeaders(opts.partnerId) } },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (status === 401 || body.code === 401 || body.code === 'Token-Error') {
    throw new ShopyyAuthError(body.msg ?? 'authorize token rejected', body.code, body.trace_id);
  }
  if (!isOkCode(body.code) || !body.data) {
    throw new ShopyyError(body.msg ?? 'authorize exchange failed', body.code, body.trace_id);
  }
  return body.data as ShopyyAuthorizeResult;
}

export interface ShopyyClientOptions {
  openapiDomain: string;
  token: string;
  /** Partner credential sent as `Tp-Partner-Id` on every call (required by shopyy). */
  partnerId?: string;
  timeoutMs?: number;
}

/**
 * Thin OpenAPI client. Injects `openapiDomain` + developer-app `token`,
 * unwraps the unified envelope, and maps `401 Token-Error` to
 * {@link ShopyyAuthError}.
 *
 * Domain helpers (orders / checkouts / webhook install) centralise the exact
 * endpoint paths and request shapes so that — when the apizza catalogue lands
 * — only this file needs editing. They are written best-effort against the
 * documented conventions; default paths are overridable via `paths`.
 */
export class ShopyyClient {
  private readonly base: string;
  private readonly token: string;
  private readonly partnerId?: string;
  private readonly timeoutMs: number;

  constructor(opts: ShopyyClientOptions) {
    this.base = opts.openapiDomain.replace(/\/+$/, '');
    this.token = opts.token;
    this.partnerId = opts.partnerId;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${this.base}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      // The gateway authenticates via the developer-app token header. Send it
      // under the documented header name plus common fallbacks so a minor
      // naming difference doesn't break auth.
      token: this.token,
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      // Partner identification headers shopyy mandates on every OpenAPI call.
      ...partnerHeaders(this.partnerId),
    };
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(opts.body);
    }
    const { status, body } = await fetchJson(
      url.toString(),
      { method, headers, body: bodyStr },
      this.timeoutMs,
    );
    if (status === 401 || body.code === 401 || body.code === 'Token-Error') {
      throw new ShopyyAuthError(body.msg ?? 'Token-Error', body.code, body.trace_id);
    }
    if (!isOkCode(body.code)) {
      throw new ShopyyError(body.msg ?? `request failed (${body.code})`, body.code, body.trace_id);
    }
    return body.data as T;
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>) {
    return this.request<T>('GET', path, { query });
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('POST', path, { body });
  }

  // ── Domain helpers ──────────────────────────────────────────────────────────

  /** List the store's currently-registered webhooks. */
  listWebhooks(): Promise<ShopyyWebhook[]> {
    return this.get<ShopyyWebhook[]>('/webhooks');
  }

  /**
   * Create/update webhooks in one call (`POST /webhooks/batchsave`). Each item
   * without an `id` is created; with an `id` it edits the existing webhook.
   * `eventId` is the shopyy event id (e.g. 5 = orders/paid, 7 = orders/fulfilled).
   */
  batchSaveWebhooks(items: ShopyyWebhookUpsert[]): Promise<unknown> {
    return this.post('/webhooks/batchsave', {
      data: items.map((w) => ({
        ...(w.id != null ? { id: w.id } : {}),
        webhook_name: w.webhookName,
        url: w.url,
        event_id: w.eventId,
        delay_time: w.delayTime ?? 0,
      })),
    });
  }

  /** Fetch a single order's full detail by the store's order id. */
  getOrder(externalOrderId: string): Promise<ShopyyRawOrder> {
    return this.get<ShopyyRawOrder>(`/orders/${encodeURIComponent(externalOrderId)}`);
  }

  /**
   * List the store's coupons (`GET /coupons`). The gateway returns either a
   * bare array or a paginated `{ list: [...] }` envelope depending on endpoint,
   * so we normalise both shapes. Requires the app's coupon API scope — without
   * it the gateway answers `503 权限验证失败`, surfaced as a {@link ShopyyError}.
   */
  async listCoupons(): Promise<ShopyyCoupon[]> {
    const data = await this.get<ShopyyCoupon[] | { list?: ShopyyCoupon[] }>('/coupons');
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.list) ? data.list : [];
  }
}

/** A coupon row as returned by `GET /coupons` (only fields we rely on). */
export interface ShopyyCoupon {
  id?: number;
  coupon_code?: string;
  coupon_name?: string;
  /** End time in Unix seconds; `-1` (or absent) = no expiry. */
  ends_at?: number;
  /** Lifecycle status (2 = active, 3 = ended); semantics best-effort. */
  status?: number;
  /** Discount spec. `discount.type`: 1 = percent off, 2 = fixed amount off. */
  param?: {
    discount?: { type?: number; value?: number };
  };
}

/** A webhook row as returned by `GET /webhooks`. */
export interface ShopyyWebhook {
  id: number;
  webhook_name?: string;
  url: string;
  event_id: number;
  event_code?: string;
}

/** Create (no `id`) or edit (with `id`) payload for `POST /webhooks/batchsave`. */
export interface ShopyyWebhookUpsert {
  id?: number;
  webhookName: string;
  url: string;
  /** shopyy event id (5 = orders/paid, 7 = orders/fulfilled, …). */
  eventId: number;
  delayTime?: number;
}
