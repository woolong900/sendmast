import type { Prisma, PrismaClient } from '@prisma/client';
import type { SegmentDefinition } from '@sendmast/shared';
import { compileSegment, type EventConstraint, type OrderConstraint } from './segment-evaluator';

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
/** Keep event-recipient lookups small enough to avoid large PG shared-memory plans. */
const EVENT_RECIPIENT_LOOKUP_CHUNK = 2_000;

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
  const { pgWhere, eventConstraints, orderConstraints } = compileSegment(def);

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
  const onlyInSet = onlyIn ? new Set(onlyIn) : null;
  const notInSet = new Set(notIn);
  const out = new Set<string>();

  // Strip our oversized AND clauses; the rest of baseWhere is still valid.
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
      if (onlyInSet && !onlyInSet.has(r.id)) continue;
      if (notInSet.has(r.id)) continue;
      out.add(r.id);
    }
    if (rows.length < BATCH) break;
    lastId = rows[rows.length - 1].id;
  }
  return out;
}

/**
 * Run a single event constraint against ClickHouse and translate the
 * resulting recipient_ids back to contactIds via PG campaign_recipients.
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

  let rows: { recipient_id: string }[];
  try {
    rows = await ctx.ch.query<{ recipient_id: string }>(
      `SELECT DISTINCT toString(recipient_id) AS recipient_id
       FROM sendmast.email_events
       WHERE account_id = {acc:UUID}
         AND event_type = {et:String}
         AND event_time >= parseDateTime64BestEffort({since:String}, 3)
         ${extraFilter}`,
      params,
    );
  } catch (err) {
    // CH outage: degrade to empty set so the segment temporarily matches
    // nothing on the event branch instead of failing the whole evaluation.
    logger.warn(
      `event evaluation failed (${ec.event}, ${ec.campaignId ?? 'any'}): ${(err as Error).message}`,
    );
    return new Set();
  }

  if (rows.length === 0) return new Set();
  if (rows.length > DERIVED_CONSTRAINT_HARD_CAP) {
    logger.warn(
      `event constraint produced ${rows.length} rows > cap ${DERIVED_CONSTRAINT_HARD_CAP}; truncating`,
    );
    rows = rows.slice(0, DERIVED_CONSTRAINT_HARD_CAP);
  }

  // recipientId → contactId via PG (archived/cold rows are not included,
  // acceptable for "last N days" lookups since N << the 90d archive age).
  const recipientIds = rows.map((r) => r.recipient_id);
  const contactIds = new Set<string>();
  for (let i = 0; i < recipientIds.length; i += EVENT_RECIPIENT_LOOKUP_CHUNK) {
    const links = await ctx.prisma.campaignRecipient.findMany({
      where: { accountId, id: { in: recipientIds.slice(i, i + EVENT_RECIPIENT_LOOKUP_CHUNK) } },
      select: { contactId: true },
    });
    for (const l of links) contactIds.add(l.contactId);
  }
  return contactIds;
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
