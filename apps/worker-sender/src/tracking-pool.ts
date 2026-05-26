import type { PrismaClient } from '@prisma/client';

/**
 * Tracking domain pool helper. Keeps a 30-second in-memory cache of every
 * `tracking_domains` row with `status='active'` so we don't hit the DB on
 * every send.
 *
 * Why 30s and not longer: an admin disabling a hot domain (e.g. it just got
 * blacklisted) wants the rotation to stop using it within seconds, not
 * minutes. 30s is a tolerable lag and still removes ~99% of DB traffic.
 *
 * Why not use Redis or a queue-driven invalidation: V1 simplicity. There's
 * exactly one writer (admin UI → API), and pool churn is rare enough that
 * eventual consistency through TTL is fine. Upgrade path is straightforward
 * if it becomes a real bottleneck.
 */

const TTL_MS = 30_000;

interface PoolSnapshot {
  domains: string[];
  fetchedAt: number;
}

let cache: PoolSnapshot | null = null;

export async function getActiveTrackingDomains(
  prisma: PrismaClient,
): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache.domains;
  const rows = await prisma.trackingDomain.findMany({
    where: { status: 'active' },
    select: { domain: true },
    // Stable order so the hash → index mapping is deterministic for a given
    // pool snapshot. Adding/removing a row reshuffles which recipient hits
    // which host, which is acceptable — same-domain consistency is a soft
    // property, not a guarantee across pool changes.
    orderBy: { domain: 'asc' },
  });
  cache = { domains: rows.map((r) => r.domain), fetchedAt: now };
  return cache.domains;
}

/**
 * Pick a tracking hostname for a given recipient. Returns `null` if the
 * pool is empty so the caller can short-circuit.
 *
 * Selection is `domains[hash(recipientId) mod count]`. Same recipient always
 * gets the same host inside one pool snapshot — keeps a single recipient's
 * opens/clicks/unsubscribes on one domain, which simplifies any future
 * cookie- or referrer-aware tracking we might add.
 *
 * djb2 is uniform enough for this use case and one cheap allocation-free
 * line; a cryptographic hash would be overkill.
 */
export function pickTrackingHost(
  domains: string[],
  recipientId: string,
): string | null {
  if (domains.length === 0) return null;
  let hash = 5381;
  for (let i = 0; i < recipientId.length; i++) {
    hash = (hash << 5) + hash + recipientId.charCodeAt(i);
    hash = hash | 0; // force i32 to avoid silent BigInt-ification on long ids
  }
  const idx = Math.abs(hash) % domains.length;
  return domains[idx];
}

/** Test helper — exposed so unit tests / repl can flush the cache. */
export function _resetTrackingPoolCache() {
  cache = null;
}
