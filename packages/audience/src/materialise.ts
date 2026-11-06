import type { SegmentDefinition } from '@sendmast/shared';
import { planSegment, scanSegment, type AudienceContext } from './resolve-segment';
import { filterSuppressed } from './suppression';

export interface AudienceSender {
  fromEmail: string;
  fromName: string;
  /** Channel the sender's domain routes to; null = dispatcher resolves later. */
  emailChannelId: string | null;
}

export interface MaterialiseAudienceInput {
  campaignId: string;
  accountId: string;
  /** Ordered by CampaignList.position — drives {{list_name}} precedence. */
  listIds: string[];
  segmentIds: string[];
  /**
   * Ordered sender roster; [0] is the primary. With >1 sender each recipient
   * is round-robined onto a sender and stamped with its from-address; with a
   * single sender the per-row from-columns stay NULL (the send path falls
   * back to Campaign.fromEmail/fromName).
   */
  senders: AudienceSender[];
  /**
   * Starting position for the sender rotation. Seed it with the number of
   * rows already materialised so a retried dispatch keeps the distribution
   * even instead of restarting at sender 0.
   */
  rotationOffset?: number;
}

export interface MaterialiseAudienceResult {
  /** Rows newly inserted by this call (skipDuplicates drops re-inserts). */
  inserted: number;
  /** Contacts dropped because their address is on the suppression list. */
  suppressed: number;
}

const BATCH = 5000;

/**
 * Stream a campaign's audience into campaign_recipients in bounded batches.
 * Audience = ∪(subscribed contacts in any list) ∪ ∪(subscribed contacts
 * matching any segment), minus the tenant's suppression list.
 *
 * Memory and PG bind-params are both bounded: lists are streamed by id
 * cursor and each segment is resolved to an id set then chunk-fetched, so
 * every `IN (…)` is ≤ BATCH. `skipDuplicates` (unique campaignId+contactId)
 * dedupes contacts shared across lists/segments and keeps retries idempotent.
 */
export async function materialiseCampaignAudience(
  ctx: AudienceContext,
  input: MaterialiseAudienceInput,
): Promise<MaterialiseAudienceResult> {
  const { prisma } = ctx;
  const { campaignId, accountId, listIds, segmentIds, senders } = input;
  const rotate = senders.length > 1;
  const primaryChannel = senders[0]?.emailChannelId ?? null;
  let positioned = input.rotationOffset ?? 0;
  let inserted = 0;
  let suppressed = 0;

  const insertBatch = async (
    rows: Array<{ id: string; email: string; listName?: string | null }>,
  ) => {
    if (rows.length === 0) return;
    const filtered = await filterSuppressed(prisma, accountId, rows);
    suppressed += filtered.suppressed;
    if (filtered.kept.length === 0) return;
    const res = await prisma.campaignRecipient.createMany({
      data: filtered.kept.map((c, j) => {
        const s = rotate ? senders[(positioned + j) % senders.length] : null;
        return {
          accountId,
          campaignId,
          contactId: c.id,
          email: c.email,
          status: 'pending' as const,
          listName: c.listName ?? null,
          fromEmail: s?.fromEmail ?? null,
          fromName: s?.fromName ?? null,
          emailChannelId: s ? s.emailChannelId : primaryChannel,
        };
      }),
      skipDuplicates: true,
    });
    positioned += filtered.kept.length;
    inserted += res.count;
  };

  // 1. Lists — cursor-stream subscribed contacts so memory stays at one
  //    batch regardless of list size. Each contact's {{list_name}} is the
  //    FIRST target list (by selection order) they belong to, frozen here.
  if (listIds.length > 0) {
    const listNameById = new Map(
      (
        await prisma.contactList.findMany({
          where: { id: { in: listIds } },
          select: { id: true, name: true },
        })
      ).map((l) => [l.id, l.name]),
    );
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.contact.findMany({
        where: {
          accountId,
          subscriptionStatus: 'subscribed',
          memberships: { some: { listId: { in: listIds } } },
        },
        select: {
          id: true,
          email: true,
          memberships: {
            where: { listId: { in: listIds } },
            select: { listId: true },
          },
        },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      if (rows.length === 0) break;
      await insertBatch(
        rows.map((c) => {
          const member = new Set(c.memberships.map((m) => m.listId));
          const firstListId = listIds.find((id) => member.has(id));
          return {
            id: c.id,
            email: c.email,
            listName: firstListId ? (listNameById.get(firstListId) ?? null) : null,
          };
        }),
      );
      if (rows.length < BATCH) break;
      cursor = rows[rows.length - 1].id;
    }
  }

  // 2. Segments — stream subscribed matching contacts in id-ordered batches
  //    (segments don't apply the subscription filter implicitly). Memory is
  //    one batch regardless of segment size.
  for (const segmentId of segmentIds) {
    const seg = await prisma.segment.findFirst({
      where: { accountId, id: segmentId },
      select: { definition: true },
    });
    if (!seg) continue;
    const plan = await planSegment(ctx, accountId, seg.definition as unknown as SegmentDefinition);
    for await (const rows of scanSegment<{ id: string; email: string }>(ctx, plan, {
      select: { id: true, email: true },
      extraWhere: { subscriptionStatus: 'subscribed' },
      batchSize: BATCH,
    })) {
      await insertBatch(rows);
    }
  }

  return { inserted, suppressed };
}
