import type { PrismaClient } from '@prisma/client';

/**
 * Drop every row whose email is on the tenant's suppression list
 * (`suppression_entries`: hard bounce, complaint, unsubscribe, manual).
 *
 * `contacts.subscription_status` is NOT a sufficient guard on its own: a
 * contact that was deleted and re-imported (or re-created by a shop sync)
 * comes back as `subscribed`, while the suppression entry — keyed by
 * (account_id, email) — survives the delete. Checking it at materialisation
 * keeps previously bounced / complained / unsubscribed addresses out of every
 * campaign regardless of how the contact row got back in.
 *
 * Emails are stored lower-cased on both sides (contact + suppression writes
 * go through the same normalisation), so an exact `IN` hits the
 * (account_id, email) unique index. Callers pass ≤ a few thousand rows.
 */
export async function filterSuppressed<T extends { email: string }>(
  prisma: PrismaClient,
  accountId: string,
  rows: T[],
): Promise<{ kept: T[]; suppressed: number }> {
  if (rows.length === 0) return { kept: rows, suppressed: 0 };
  const emails = [...new Set(rows.map((r) => r.email.toLowerCase()))];
  const hits = await prisma.suppressionEntry.findMany({
    where: { accountId, email: { in: emails } },
    select: { email: true },
  });
  if (hits.length === 0) return { kept: rows, suppressed: 0 };
  const blocked = new Set(hits.map((h) => h.email.toLowerCase()));
  const kept = rows.filter((r) => !blocked.has(r.email.toLowerCase()));
  return { kept, suppressed: rows.length - kept.length };
}

/** True when a single address is on the tenant's suppression list. */
export async function isSuppressed(
  prisma: PrismaClient,
  accountId: string,
  email: string,
): Promise<boolean> {
  const hit = await prisma.suppressionEntry.findUnique({
    where: { accountId_email: { accountId, email: email.toLowerCase() } },
    select: { id: true },
  });
  return hit !== null;
}
