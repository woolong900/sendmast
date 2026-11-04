import type { SendResult } from './transport';

/**
 * Tenant prepaid quota is reserved BEFORE the provider call (atomic guard
 * against overspending under concurrency). Billing policy: a failure caused
 * by the platform / provider side gives the reserved unit back; a failure
 * attributable to the message or recipient (invalid address, rejected
 * content — HTTP 4xx other than auth/rate-limit/timeout) stays charged.
 *
 * Platform side =
 *   - `Error`: no HTTP response at all (network error, timeout, SDK threw);
 *   - HTTP 5xx: provider outage;
 *   - HTTP 401 / 403: channel credentials / sender identity misconfigured;
 *   - HTTP 408 / 429: provider timeout / rate limit.
 */
export function isPlatformSideFailure(result: Pick<SendResult, 'ok' | 'providerStatus'>): boolean {
  if (result.ok) return false;
  const status = result.providerStatus;
  if (status === 'Error') return true;
  const m = /^Http(\d{3})$/.exec(status);
  if (!m) return false;
  const code = Number(m[1]);
  return code >= 500 || code === 401 || code === 403 || code === 408 || code === 429;
}
