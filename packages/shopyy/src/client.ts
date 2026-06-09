import { buildSignedQuery } from './sign.js';
import type {
  ShopyyAuthorizeResult,
  ShopyyEnvelope,
  ShopyyRawCheckout,
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
    { method: 'GET', headers: { Accept: 'application/json' } },
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
  private readonly timeoutMs: number;

  constructor(opts: ShopyyClientOptions) {
    this.base = opts.openapiDomain.replace(/\/+$/, '');
    this.token = opts.token;
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

  // ── Domain helpers (adapter layer; endpoint paths are best-effort) ──────────

  /**
   * Register a webhook so the store pushes order/checkout events to us.
   * `fromId`/`fromName` are the installed app's id/name per the doc.
   * Returns the raw response so callers can persist any provider handle.
   */
  installWebhook(input: {
    topic: string;
    address: string;
    fromId: string;
    fromName: string;
  }): Promise<unknown> {
    return this.post('/webhook/install', {
      topic: input.topic,
      address: input.address,
      from_id: input.fromId,
      from_name: input.fromName,
    });
  }

  /** Fetch a single order's full detail by the store's order id. */
  getOrder(externalOrderId: string): Promise<ShopyyRawOrder> {
    return this.get<ShopyyRawOrder>(`/order/detail`, { order_id: externalOrderId });
  }

  /** List abandoned checkouts updated since `since` (Unix seconds). */
  listAbandonedCheckouts(since: number, page = 1, pageSize = 50): Promise<ShopyyRawCheckout[]> {
    return this.get<ShopyyRawCheckout[]>(`/checkout/abandoned`, {
      updated_at_min: since,
      page,
      page_size: pageSize,
    });
  }
}
