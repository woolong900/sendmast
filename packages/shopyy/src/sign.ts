import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shopyy (OEMSAAS) request signing.
 *
 * Algorithm (from the 语雀 authorization doc, verified against the live
 * gateway):
 *   1. Collect all request params except `sign`.
 *   2. Sort keys in dictionary (lexicographic) order.
 *   3. RFC3986-encode both key and value.
 *   4. Join as `k=v` pairs with `&`.
 *   5. HMAC-SHA1 over that string with the app secret, base64-encode.
 *   6. URL-safe replace: `+`->`-`, `/`->`_`, `=`->`` (stripped).
 *
 * The same routine signs the authorize-token exchange (secret = app secret)
 * and verifies inbound webhooks (secret = our per-connection webhookSecret).
 */

export type SignParams = Record<string, string | number | boolean | undefined | null>;

/**
 * RFC3986 percent-encoding. `encodeURIComponent` leaves `!'()*` unescaped;
 * RFC3986 requires them escaped, so we patch those four.
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Build the canonical signing base string (steps 1-4 above). */
export function buildSignBase(params: SignParams): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(String(params[k]))}`)
    .join('&');
}

/** Compute the URL-safe base64 HMAC-SHA1 signature for `params`. */
export function sign(params: SignParams, secret: string): string {
  const base = buildSignBase(params);
  return createHmac('sha1', secret)
    .update(base, 'utf8')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** A cryptographically-random nonce suitable for replay protection. */
export function randomNonce(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Augment `params` with the standard signing envelope fields and return the
 * full query object (including `sign`). Pass `extra` if the gateway needs
 * additional fixed fields.
 */
export function buildSignedQuery(
  params: SignParams,
  secret: string,
): Record<string, string> {
  const enriched: SignParams = {
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    nonce: params.nonce ?? randomNonce(),
    signatureMethod: params.signatureMethod ?? 'HMAC-SHA1',
    ...params,
  };
  const signature = sign(enriched, secret);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(enriched)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  out.sign = signature;
  return out;
}

/**
 * Constant-time verification of an inbound signature. `provided` is the
 * `sign` value the caller sent; we recompute over the remaining params and
 * compare without leaking timing.
 */
export function verifySign(
  params: SignParams,
  secret: string,
  provided: string | undefined,
): boolean {
  if (!provided) return false;
  const expected = sign(params, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
