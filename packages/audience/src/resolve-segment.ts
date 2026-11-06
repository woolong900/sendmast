import type { Prisma, PrismaClient } from '@prisma/client';
import type { SegmentDefinition } from '@sendmast/shared';
import {
  compileSegment,
  type EventConstraint,
  type OrderConstraint,
  type SiteEventConstraint,
} from './segment-evaluator';

/** Minimal ClickHouse surface the resolver needs (JSONEachRow query). */
export interface AudienceClickHouse {
  query<T>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
}

export interface AudienceLogger {
  warn(message: string): void;
}

export interface AudienceContext {
  prisma: PrismaClient;
  ch: AudienceClickHouse;
  logger?: AudienceLogger;
}

/**
 * Cap on how many contactIds we'll round-trip through application memory
 * when evaluating event-based rules. Beyond this we degrade to "empty set"
 * (logged) rather than risk OOMing the process. v1: hard cap, no chunked
 * scan; revisit when a tenant actually hits the ceiling.
 */
const DERIVED_CONSTRAINT_HARD_CAP = 1_000_000;
/**
 * Prisma sends every `id IN (...)` value as a bind parameter. Postgres rejects
 * prepared statements above 32767 parameters; keep this safely below that once
 * accountId and other rule predicates are included.
 */
const PRISMA_IN_BIND_SAFE_LIMIT = 25_000;
/** Stay below Postgres' bind cap while avoiding hundreds of tiny lookups. */
const EVENT_RECIPIENT_LOOKUP_CHUNK = 20_000;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const consoleLogger: AudienceLogger = { warn: (m) => console.warn(`[audience] ${m}`) };

/**
 * Evaluate a segment definition to the set of matching contact ids (no
 * subscription filter applied implicitly). Shared by the API (preview /
 * refresh / contacts page) and worker-sender (campaign materialisation) so
 * both always agree on who is in a segment.
 */
export async function resolveSegmentContactIds(
  ctx: AudienceContext,
  accountId: string,
  def: SegmentDefinition,
): Promise<Set<string>> {
  const { prisma } = ctx;
  const logger = ctx.logger ?? consoleLogger;
  const { pgWhere, eventConstraints, orderConstraints, siteEventConstraints } = compileSegment(def);

  // Apply event/order constraints first so we can narrow the contact query.
  // For 'has' constraints: intersect the event-derived contactId set.
  // For 'notHas' constraints: collect to exclude later.
  const hasSets: Set<string>[] = [];
  const notHasIds: string[] = [];

  for (const ec of eventConstraints) {
    const ids = await contactIdsFromEvent(ctx, logger, accountId, ec);
    if (ec.mode === 'has') hasSets.push(ids);
    else notHasIds.push(...ids);
  }

  for (const oc of orderConstraints) {
    const ids = await contactIdsFromOrder(prisma, logger, accountId, oc);
    if (oc.mode === 'has') hasSets.push(ids);
    else notHasIds.push(...ids);
  }

  // Site events: the query always returns contacts that reached minCount;
  // 'notHas' excludes exactly those (→ "fewer than minCount", 1 = never).
  for (const sc of siteEventConstraints) {
    const ids = await contactIdsFromSiteEvent(ctx, logger, accountId, sc);
    if (sc.mode === 'has') hasSets.push(ids);
    else notHasIds.push(...ids);
  }

  // Intersection of all 'has' sets (must satisfy each one).
  let candidateIds: string[] | undefined;
  if (hasSets.length > 0) {
    let intersected = hasSets[0];
    for (let i = 1; i < hasSets.length; i++) {
      const next = hasSets[i];
      const out = new Set<string>();
      for (const id of intersected) if (next.has(id)) out.add(id);
      intersected = out;
    }
    candidateIds = [...intersected];
    if (candidateIds.length === 0) return new Set();
  }

  // Build the final PG query: tenant scope + compiled WHERE + IN-set if
  // we narrowed via events + NOT-IN-set for 'notHas' events.
  const where: Prisma.ContactWhereInput = { accountId, ...pgWhere };
  if (candidateIds) {
    if (candidateIds.length > PRISMA_IN_BIND_SAFE_LIMIT) {
      return resolveLarge(prisma, where, candidateIds, notHasIds);
    }
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { id: { in: candidateIds } },
    ];
  }
  if (notHasIds.length > 0) {
    const dedup = [...new Set(notHasIds)];
    if (dedup.length > PRISMA_IN_BIND_SAFE_LIMIT) {
      return resolveLarge(prisma, where, candidateIds ?? null, dedup);
    }
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { NOT: { id: { in: dedup } } },
    ];
  }

  const rows = await prisma.contact.findMany({ where, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/**
 * Slow path: when the IN list would be too large for one PG query we fall
 * back to scanning Contact in chunks and filtering in-app.
 */
async function resolveLarge(
  prisma: PrismaClient,
  baseWhere: Prisma.ContactWhereInput,
  onlyIn: string[] | null,
  notIn: string[],
): Promise<Set<string>> {
  const notInSet = new Set(notIn);
  const out = new Set<string>();

  // When a derived event/order rule already gave us the candidate ids, query
  // those ids in bind-safe chunks. Scanning every contact in the account made
  // large behaviour segments unnecessarily slow (millions of rows for a
  // six-figure opener set).
  if (onlyIn) {
    const ids = [...new Set(onlyIn)].filter((id) => !notInSet.has(id));
    for (let i = 0; i < ids.length; i += PRISMA_IN_BIND_SAFE_LIMIT) {
      const chunk = ids.slice(i, i + PRISMA_IN_BIND_SAFE_LIMIT);
      const rows = await prisma.contact.findMany({
        where: {
          ...baseWhere,
          AND: [
            ...(Array.isArray(baseWhere.AND)
              ? baseWhere.AND
              : baseWhere.AND
                ? [baseWhere.AND]
                : []),
            { id: { in: chunk } },
          ],
        },
        select: { id: true },
      });
      for (const row of rows) out.add(row.id);
    }
    return out;
  }

  // A large NOT-IN set without an inclusion set still requires scanning the
  // tenant's contacts and excluding matches in-app.
  const where: Prisma.ContactWhereInput = { ...baseWhere };
  delete (where as Prisma.ContactWhereInput).AND;

  const BATCH = 10_000;
  let lastId: string | null = null;
  for (;;) {
    const rows: { id: string }[] = await prisma.contact.findMany({
      where: lastId ? { ...where, id: { gt: lastId } } : where,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      if (notInSet.has(r.id)) continue;
      out.add(r.id);
    }
    if (rows.length < BATCH) break;
    lastId = rows[rows.length - 1].id;
  }
  return out;
}

/**
 * Run a single event constraint against ClickHouse. contact_id is the fast
 * path, but recipient_id is always resolved as a compatibility path: some
 * production rows contain a non-zero contact_id that no longer corresponds to
 * a Contact, so limiting the fallback to the zero UUID silently returned 0.
 * Recipient ids are resolved through the hot PG table and the CH cold archive.
 * account_id is the leading sort key on email_events, so we always filter on
 * it first (perf + tenant isolation defence-in-depth).
 */
async function contactIdsFromEvent(
  ctx: AudienceContext,
  logger: AudienceLogger,
  accountId: string,
  ec: EventConstraint,
): Promise<Set<string>> {
  const params: Record<string, unknown> = {
    acc: accountId,
    et: ec.event,
    since: ec.since.toISOString(),
  };
  let extraFilter = '';
  if (ec.campaignId) {
    extraFilter = 'AND campaign_id = {cid:UUID}';
    params.cid = ec.campaignId;
  }

  let directRows: { contact_id: string }[];
  let recipientRows: { recipient_id: string }[];
  try {
    [directRows, recipientRows] = await Promise.all([
      ctx.ch.query<{ contact_id: string }>(
        `SELECT DISTINCT toString(contact_id) AS contact_id
         FROM sendmast.email_events
         WHERE account_id = {acc:UUID}
           AND event_type = {et:String}
           AND event_time >= parseDateTime64BestEffort({since:String}, 3)
           AND is_bot = 0
           AND contact_id != toUUID('${ZERO_UUID}')
           ${extraFilter}
         LIMIT ${DERIVED_CONSTRAINT_HARD_CAP + 1}`,
        params,
      ),
      ctx.ch.query<{ recipient_id: string }>(
        `SELECT DISTINCT toString(recipient_id) AS recipient_id
         FROM sendmast.email_events
         WHERE account_id = {acc:UUID}
           AND event_type = {et:String}
           AND event_time >= parseDateTime64BestEffort({since:String}, 3)
           AND is_bot = 0
           AND recipient_id != toUUID('${ZERO_UUID}')
           ${extraFilter}
         LIMIT ${DERIVED_CONSTRAINT_HARD_CAP + 1}`,
        params,
      ),
    ]);
  } catch (err) {
    // CH outage: degrade to empty set so the segment temporarily matches
    // nothing on the event branch instead of failing the whole evaluation.
    logger.warn(
      `event evaluation failed (${ec.event}, ${ec.campaignId ?? 'any'}): ${(err as Error).message}`,
    );
    return new Set();
  }

  if (directRows.length > DERIVED_CONSTRAINT_HARD_CAP) {
    logger.warn(
      `event constraint produced more than ${DERIVED_CONSTRAINT_HARD_CAP} direct contacts; truncating`,
    );
  }
  const contactIds = new Set(
    directRows.slice(0, DERIVED_CONSTRAINT_HARD_CAP).map((r) => r.contact_id),
  );

  if (recipientRows.length === 0 || contactIds.size >= DERIVED_CONSTRAINT_HARD_CAP) {
    return contactIds;
  }
  if (recipientRows.length > DERIVED_CONSTRAINT_HARD_CAP) {
    logger.warn(
      `event constraint produced more than ${DERIVED_CONSTRAINT_HARD_CAP} recipients; truncating`,
    );
    recipientRows = recipientRows.slice(0, DERIVED_CONSTRAINT_HARD_CAP);
  }

  const mapHotRecipients = async (): Promise<string[]> => {
    const mapped: string[] = [];
    for (let i = 0; i < recipientRows.length; i += EVENT_RECIPIENT_LOOKUP_CHUNK) {
      const links = await ctx.prisma.campaignRecipient.findMany({
        where: {
          accountId,
          id: {
            in: recipientRows.slice(i, i + EVENT_RECIPIENT_LOOKUP_CHUNK).map((r) => r.recipient_id),
          },
        },
        select: { contactId: true },
      });
      for (const link of links) mapped.push(link.contactId);
    }
    return mapped;
  };

  // A 300-day rule can include campaigns whose PG recipients have already
  // moved to cold storage. Join the legacy events to that archive in CH so
  // those contacts are not silently omitted.
  const mapArchivedRecipients = async (): Promise<string[]> => {
    try {
      const rows = await ctx.ch.query<{ contact_id: string }>(
        `SELECT DISTINCT toString(a.contact_id) AS contact_id
         FROM sendmast.email_events AS e
         INNER JOIN (
           SELECT id, contact_id
           FROM sendmast.campaign_recipients_archive FINAL
           WHERE account_id = {acc:UUID}
         ) AS a ON a.id = e.recipient_id
         WHERE e.account_id = {acc:UUID}
           AND e.event_type = {et:String}
           AND e.event_time >= parseDateTime64BestEffort({since:String}, 3)
           AND e.is_bot = 0
           ${ec.campaignId ? 'AND e.campaign_id = {cid:UUID}' : ''}
         LIMIT ${DERIVED_CONSTRAINT_HARD_CAP + 1}`,
        params,
      );
      if (rows.length > DERIVED_CONSTRAINT_HARD_CAP) {
        logger.warn(
          `event constraint produced more than ${DERIVED_CONSTRAINT_HARD_CAP} archived contacts; truncating`,
        );
      }
      return rows.slice(0, DERIVED_CONSTRAINT_HARD_CAP).map((r) => r.contact_id);
    } catch (err) {
      // The hot-table mapping is still useful if the archive is temporarily
      // unavailable or an older installation has not created it yet.
      logger.warn(
        `archived event evaluation failed (${ec.event}, ${ec.campaignId ?? 'any'}): ${(err as Error).message}`,
      );
      return [];
    }
  };

  const [hotContactIds, archivedContactIds] = await Promise.all([
    mapHotRecipients(),
    mapArchivedRecipients(),
  ]);
  for (const id of hotContactIds) {
    if (contactIds.size >= DERIVED_CONSTRAINT_HARD_CAP) break;
    contactIds.add(id);
  }
  for (const id of archivedContactIds) {
    if (contactIds.size >= DERIVED_CONSTRAINT_HARD_CAP) break;
    contactIds.add(id);
  }

  return contactIds;
}

/**
 * Contacts that performed a storefront event at least `minCount` times since
 * `since` (ClickHouse site_events; contact ids are resolved at ingest, so no
 * PG mapping step). A CH failure fails the evaluation instead of degrading to
 * an empty set: for a 'notHas' rule an empty exclusion set would silently
 * widen the audience (e.g. mail every "加购未支付" contact including buyers).
 */
async function contactIdsFromSiteEvent(
  ctx: AudienceContext,
  logger: AudienceLogger,
  accountId: string,
  sc: SiteEventConstraint,
): Promise<Set<string>> {
  const params: Record<string, unknown> = {
    acc: accountId,
    et: sc.event,
    since: sc.since.toISOString(),
    n: sc.minCount,
  };
  let extraFilter = '';
  if (sc.campaignId) {
    extraFilter = "AND source_type = 'campaign' AND source_id = {cid:UUID}";
    params.cid = sc.campaignId;
  }
  const rows = await ctx.ch.query<{ contact_id: string }>(
    `SELECT toString(contact_id) AS contact_id
     FROM sendmast.site_events
     WHERE account_id = {acc:UUID}
       AND event_type = {et:String}
       AND event_time >= parseDateTime64BestEffort({since:String}, 3)
       AND is_bot = 0
       ${extraFilter}
     GROUP BY contact_id
     HAVING count() >= {n:UInt32}
     LIMIT ${DERIVED_CONSTRAINT_HARD_CAP + 1}`,
    params,
  );
  if (rows.length > DERIVED_CONSTRAINT_HARD_CAP) {
    logger.warn(
      `site event constraint produced more than ${DERIVED_CONSTRAINT_HARD_CAP} contacts; truncating`,
    );
  }
  return new Set(rows.slice(0, DERIVED_CONSTRAINT_HARD_CAP).map((r) => r.contact_id));
}

/** Resolve contacts with a paid/shipped order inside a fixed date range. */
async function contactIdsFromOrder(
  prisma: PrismaClient,
  logger: AudienceLogger,
  accountId: string,
  constraint: OrderConstraint,
): Promise<Set<string>> {
  const rows = await prisma.shopOrder.findMany({
    where: {
      accountId,
      status: { in: ['paid', 'shipped'] },
      contactId: { not: null },
      orderTime: { gte: constraint.from, lte: constraint.to },
    },
    select: { contactId: true },
    distinct: ['contactId'],
    take: DERIVED_CONSTRAINT_HARD_CAP + 1,
  });

  if (rows.length > DERIVED_CONSTRAINT_HARD_CAP) {
    logger.warn(
      `order constraint produced more than ${DERIVED_CONSTRAINT_HARD_CAP} contacts; truncating`,
    );
  }

  return new Set(
    rows
      .slice(0, DERIVED_CONSTRAINT_HARD_CAP)
      .map((row) => row.contactId)
      .filter((contactId): contactId is string => contactId !== null),
  );
}
