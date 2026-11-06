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
 * A compiled segment, ready to count / page / stream without ever holding
 * the whole audience in memory:
 *   - `where`:   tenant scope + every contact-column rule (one PG predicate);
 *   - `include`: contacts satisfying ALL derived "has" rules (events, orders,
 *                storefront), already minus the derived exclusions, sorted by
 *                id — or null when the segment has no derived "has" rule;
 *   - `exclude`: derived "notHas" contacts; only used when include is null.
 * Derived sets come from ClickHouse / shop orders and are capped at
 * DERIVED_CONSTRAINT_HARD_CAP, so they are the only in-memory id sets.
 */
export interface SegmentPlan {
  where: Prisma.ContactWhereInput;
  include: string[] | null;
  exclude: Set<string>;
}

export async function planSegment(
  ctx: AudienceContext,
  accountId: string,
  def: SegmentDefinition,
): Promise<SegmentPlan> {
  const { prisma } = ctx;
  const logger = ctx.logger ?? consoleLogger;
  const { pgWhere, eventConstraints, orderConstraints, siteEventConstraints } = compileSegment(def);

  const hasSets: Set<string>[] = [];
  const exclude = new Set<string>();
  const add = (mode: 'has' | 'notHas', ids: Set<string>) => {
    if (mode === 'has') hasSets.push(ids);
    else for (const id of ids) exclude.add(id);
  };
  for (const ec of eventConstraints)
    add(ec.mode, await contactIdsFromEvent(ctx, logger, accountId, ec));
  for (const oc of orderConstraints)
    add(oc.mode, await contactIdsFromOrder(prisma, logger, accountId, oc));
  // Site events: the query returns contacts that reached minCount; 'notHas'
  // excludes exactly those (→ "fewer than minCount", 1 = never).
  for (const sc of siteEventConstraints)
    add(sc.mode, await contactIdsFromSiteEvent(ctx, logger, accountId, sc));

  const where: Prisma.ContactWhereInput = { accountId, ...pgWhere };
  if (hasSets.length === 0) return { where, include: null, exclude };

  // Intersect smallest-first so the working set only shrinks.
  hasSets.sort((a, b) => a.size - b.size);
  const include: string[] = [];
  outer: for (const id of hasSets[0]!) {
    if (exclude.has(id)) continue;
    for (let i = 1; i < hasSets.length; i++) if (!hasSets[i]!.has(id)) continue outer;
    include.push(id);
  }
  include.sort();
  return { where, include, exclude: new Set() };
}

function andWhere(...parts: Array<Prisma.ContactWhereInput | undefined>): Prisma.ContactWhereInput {
  const list = parts.filter((p): p is Prisma.ContactWhereInput => !!p && Object.keys(p).length > 0);
  return list.length === 1 ? list[0]! : { AND: list };
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Number of contacts in the segment (optionally narrowed by `extraWhere`).
 * Pure COUNT queries: no rule → one COUNT; derived inclusion → COUNTs over
 * id chunks; derived exclusion → total minus the excluded ids that match.
 */
export async function countSegment(
  ctx: AudienceContext,
  plan: SegmentPlan,
  extraWhere?: Prisma.ContactWhereInput,
): Promise<number> {
  const base = andWhere(plan.where, extraWhere);
  if (plan.include) {
    let n = 0;
    for (const chunk of chunks(plan.include, PRISMA_IN_BIND_SAFE_LIMIT)) {
      n += await ctx.prisma.contact.count({ where: andWhere(base, { id: { in: chunk } }) });
    }
    return n;
  }
  let n = await ctx.prisma.contact.count({ where: base });
  if (plan.exclude.size > 0) {
    for (const chunk of chunks([...plan.exclude], PRISMA_IN_BIND_SAFE_LIMIT)) {
      n -= await ctx.prisma.contact.count({ where: andWhere(base, { id: { in: chunk } }) });
    }
  }
  return Math.max(0, n);
}

/**
 * Stream the segment's contacts in id order, `batchSize` rows at a time.
 * Memory stays at one batch (plus the capped derived sets) however large
 * the segment is — keyset pagination on the primary key, no OFFSET.
 */
export async function* scanSegment<T extends { id: string } = { id: string }>(
  ctx: AudienceContext,
  plan: SegmentPlan,
  opts: { select: Prisma.ContactSelect; extraWhere?: Prisma.ContactWhereInput; batchSize?: number },
): AsyncGenerator<T[]> {
  const batchSize = Math.min(opts.batchSize ?? 5000, PRISMA_IN_BIND_SAFE_LIMIT);
  const select: Prisma.ContactSelect = { ...opts.select, id: true };
  const base = andWhere(plan.where, opts.extraWhere);

  if (plan.include) {
    for (const chunk of chunks(plan.include, batchSize)) {
      const rows = await ctx.prisma.contact.findMany({
        where: andWhere(base, { id: { in: chunk } }),
        select,
        orderBy: { id: 'asc' },
      });
      if (rows.length > 0) yield rows as unknown as T[];
    }
    return;
  }

  let lastId: string | null = null;
  for (;;) {
    const rows = (await ctx.prisma.contact.findMany({
      where: lastId ? andWhere(base, { id: { gt: lastId } }) : base,
      select,
      orderBy: { id: 'asc' },
      take: batchSize,
    })) as Array<{ id: string }>;
    if (rows.length === 0) return;
    lastId = rows[rows.length - 1]!.id;
    const kept = plan.exclude.size > 0 ? rows.filter((r) => !plan.exclude.has(r.id)) : rows;
    if (kept.length > 0) yield kept as unknown as T[];
    if (rows.length < batchSize) return;
  }
}

/** One page (1-based) of the segment in id order. */
export async function pageSegment<T extends { id: string } = { id: string }>(
  ctx: AudienceContext,
  plan: SegmentPlan,
  page: number,
  pageSize: number,
  select: Prisma.ContactSelect,
): Promise<T[]> {
  const fullSelect: Prisma.ContactSelect = { ...select, id: true };
  const offset = (page - 1) * pageSize;
  if (!plan.include && plan.exclude.size === 0) {
    return (await ctx.prisma.contact.findMany({
      where: plan.where,
      select: fullSelect,
      orderBy: { id: 'asc' },
      skip: offset,
      take: pageSize,
    })) as unknown as T[];
  }
  const out: T[] = [];
  let skip = offset;
  for await (const batch of scanSegment<T>(ctx, plan, {
    select: fullSelect,
    batchSize: Math.max(1000, pageSize),
  })) {
    if (skip >= batch.length) {
      skip -= batch.length;
      continue;
    }
    out.push(...batch.slice(skip, skip + pageSize - out.length));
    skip = 0;
    if (out.length >= pageSize) break;
  }
  return out;
}

/**
 * Full id set of a segment. Prefer countSegment / pageSegment / scanSegment:
 * this materialises the whole audience in memory and is kept for callers
 * that genuinely need the set.
 */
export async function resolveSegmentContactIds(
  ctx: AudienceContext,
  accountId: string,
  def: SegmentDefinition,
): Promise<Set<string>> {
  const plan = await planSegment(ctx, accountId, def);
  const out = new Set<string>();
  for await (const batch of scanSegment(ctx, plan, { select: { id: true }, batchSize: 10_000 })) {
    for (const r of batch) out.add(r.id);
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

  // Result aliases must NOT reuse the column names: ClickHouse resolves a
  // SELECT alias inside WHERE, so `toString(contact_id) AS contact_id` turned
  // `contact_id != toUUID(...)` into a String-vs-UUID comparison and every
  // open/click rule failed ("no supertype for types String, UUID") → 0.
  let directRows: { cid: string }[];
  let recipientRows: { rid: string }[];
  try {
    [directRows, recipientRows] = await Promise.all([
      ctx.ch.query<{ cid: string }>(
        `SELECT DISTINCT toString(contact_id) AS cid
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
      ctx.ch.query<{ rid: string }>(
        `SELECT DISTINCT toString(recipient_id) AS rid
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
  const contactIds = new Set(directRows.slice(0, DERIVED_CONSTRAINT_HARD_CAP).map((r) => r.cid));

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
            in: recipientRows.slice(i, i + EVENT_RECIPIENT_LOOKUP_CHUNK).map((r) => r.rid),
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
      const rows = await ctx.ch.query<{ cid: string }>(
        `SELECT DISTINCT toString(a.contact_id) AS cid
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
      return rows.slice(0, DERIVED_CONSTRAINT_HARD_CAP).map((r) => r.cid);
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
  const rows = await ctx.ch.query<{ cid: string }>(
    `SELECT toString(contact_id) AS cid
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
  return new Set(rows.slice(0, DERIVED_CONSTRAINT_HARD_CAP).map((r) => r.cid));
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
