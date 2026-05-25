import type { PrismaClient } from '@prisma/client';
import {
  insertArchivedRecipients,
  type ArchivedRecipientRow,
  type ClickHouseClient,
} from '@sendmast/clickhouse';

/// How old a terminal campaign must be before its recipients move to CH.
const ARCHIVE_AGE_DAYS = Number(process.env.RECIPIENT_ARCHIVE_AGE_DAYS ?? '90');
/// Rows copied → deleted per round-trip. Tuned for "small enough that CH/PG
/// don't choke, large enough that 1M-recipient campaigns finish in minutes".
const BATCH_SIZE = Number(process.env.RECIPIENT_ARCHIVE_BATCH_SIZE ?? '5000');
/// Hard upper bound on per-run wall time so a backlog can't starve the rest
/// of the worker for hours. The cron picks up where it left off next day.
const MAX_RUN_MS = Number(process.env.RECIPIENT_ARCHIVE_MAX_RUN_MS ?? String(30 * 60 * 1000));

interface ArchiveStats {
  campaignsScanned: number;
  campaignsArchived: number;
  recipientsArchived: number;
  durationMs: number;
}

/**
 * Pick terminal campaigns older than ARCHIVE_AGE_DAYS that haven't been
 * archived yet, and for each one stream its recipients to ClickHouse in
 * BATCH_SIZE chunks, deleting from PG after each successful CH insert.
 *
 * Idempotent: if interrupted halfway through a campaign, the next run sees
 * the (now smaller) PG row count and continues. The archive_state marker
 * is only written once *all* of this campaign's PG rows are gone.
 *
 * Webhook lookups for these recipients now fall through to a CH query
 * (see worker-events/src/main.ts → resolveRecipient).
 */
export async function runArchiveJob(
  prisma: PrismaClient,
  ch: ClickHouseClient,
): Promise<ArchiveStats> {
  const start = Date.now();
  const cutoff = new Date(Date.now() - ARCHIVE_AGE_DAYS * 24 * 3600 * 1000);
  const stats: ArchiveStats = {
    campaignsScanned: 0,
    campaignsArchived: 0,
    recipientsArchived: 0,
    durationMs: 0,
  };

  // Find candidates: terminal status, old enough, NOT already archived.
  // Subquery is intentionally NOT INDEXED (table is tiny) — PG inlines it.
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT c.id
    FROM campaigns c
    LEFT JOIN campaign_archive_state s ON s.campaign_id = c.id
    WHERE s.campaign_id IS NULL
      AND c.status IN ('sent', 'canceled', 'failed')
      AND c.created_at < ${cutoff}
    ORDER BY c.created_at ASC
  `;
  stats.campaignsScanned = candidates.length;

  for (const { id: campaignId } of candidates) {
    if (Date.now() - start > MAX_RUN_MS) {
      console.warn(`[archive] hit MAX_RUN_MS=${MAX_RUN_MS}, stopping early`);
      break;
    }
    try {
      const archivedCount = await archiveOneCampaign(prisma, ch, campaignId);
      stats.recipientsArchived += archivedCount;
      stats.campaignsArchived += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[archive] campaign=${campaignId} failed: ${msg}`);
      // Don't write archive_state — next run will retry this campaign.
      // Continue to the next candidate.
    }
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

async function archiveOneCampaign(
  prisma: PrismaClient,
  ch: ClickHouseClient,
  campaignId: string,
): Promise<number> {
  let totalArchived = 0;
  // Paginate by id ASC because (a) id is the PK so this index-scans cheaply,
  // and (b) we DELETE as we go, so there's no "skip what we already did"
  // problem — every iteration the next page is just `LIMIT BATCH_SIZE`.
  // (Cursor pagination would also work but is overkill here.)
  for (;;) {
    const rows = await prisma.campaignRecipient.findMany({
      where: { campaignId },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
    });
    if (rows.length === 0) break;

    const archiveRows: ArchivedRecipientRow[] = rows.map((r) => ({
      id: r.id,
      account_id: r.accountId,
      campaign_id: r.campaignId,
      contact_id: r.contactId,
      email: r.email,
      status: r.status,
      message_id: r.messageId,
      error_message: r.errorMessage,
      sent_at: r.sentAt ? toCHDateTime(r.sentAt) : null,
      created_at: toCHDateTime(r.createdAt),
    }));

    // ClickHouse first — if this fails we keep PG intact and retry next run.
    await insertArchivedRecipients(ch, archiveRows);

    // Then delete from PG. Note: we delete by *id list*, not by campaignId,
    // so we don't accidentally wipe rows added between the SELECT and DELETE
    // (rare for terminal campaigns, but possible if a webhook backfill
    // created a row).
    const ids = rows.map((r) => r.id);
    const del = await prisma.campaignRecipient.deleteMany({
      where: { id: { in: ids } },
    });
    totalArchived += del.count;

    // If PG returned fewer than the batch we asked for, that means we drained
    // the campaign — break so we don't spin doing empty SELECTs.
    if (rows.length < BATCH_SIZE) break;
  }

  // Mark the campaign as archived. Use upsert so a partial-then-resumed run
  // (which would already have a partial state row from the recipientCount
  // counter below) doesn't blow up on PK conflict.
  await prisma.campaignArchiveState.upsert({
    where: { campaignId },
    update: { recipientCount: { increment: totalArchived } },
    create: { campaignId, recipientCount: totalArchived },
  });

  console.log(`[archive] campaign=${campaignId} archived=${totalArchived} rows`);
  return totalArchived;
}

/**
 * ClickHouse 24.x's DateTime64 JSON parser rejects the `Z` UTC suffix that
 * `Date.toISOString()` produces; it wants `YYYY-MM-DD HH:MM:SS.sss`. CH
 * treats the value as UTC because the column is declared `DateTime64(3, 'UTC')`.
 */
function toCHDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
