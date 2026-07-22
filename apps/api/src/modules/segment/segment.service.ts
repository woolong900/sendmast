import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClickHouseService } from '../../common/clickhouse/clickhouse.service';
import type {
  CreateSegmentInput,
  ListSegmentContactsQuery,
  SegmentContactsPage,
  SegmentDefinition,
  SegmentPreviewResult,
  SegmentView,
  UpdateSegmentInput,
} from '@sendmast/shared';
import { compileSegment, type EventConstraint } from './segment-evaluator';

/**
 * Cap on how many contactIds we'll round-trip through application memory
 * when evaluating event-based rules. Beyond this we degrade to "empty set"
 * (logged) rather than risk OOMing the API process. v1: hard cap, no chunked
 * scan; revisit when a tenant actually hits the ceiling.
 */
const EVENT_CONSTRAINT_HARD_CAP = 1_000_000;
/**
 * Prisma sends every `id IN (...)` value as a bind parameter. Postgres rejects
 * prepared statements above 32767 parameters; keep this safely below that once
 * accountId and other rule predicates are included.
 */
const PRISMA_IN_BIND_SAFE_LIMIT = 25_000;
/** Keep event-recipient lookups small enough to avoid large PG shared-memory plans. */
const EVENT_RECIPIENT_LOOKUP_CHUNK = 2_000;

@Injectable()
export class SegmentService {
  private readonly logger = new Logger(SegmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ch: ClickHouseService,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async list(accountId: string): Promise<SegmentView[]> {
    const rows = await this.prisma.segment.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async get(accountId: string, id: string): Promise<SegmentView> {
    const r = await this.prisma.segment.findFirst({ where: { id, accountId } });
    if (!r) throw new NotFoundException('分群不存在');
    return this.toView(r);
  }

  async create(accountId: string, input: CreateSegmentInput): Promise<SegmentView> {
    await this.assertListRulesOwned(accountId, input.definition);
    try {
      const row = await this.prisma.segment.create({
        data: {
          accountId,
          name: input.name,
          description: input.description ?? null,
          definition: input.definition as unknown as Prisma.InputJsonValue,
        },
      });
      return this.toView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('同名分群已存在');
      }
      throw err;
    }
  }

  async update(accountId: string, id: string, input: UpdateSegmentInput): Promise<SegmentView> {
    const existing = await this.prisma.segment.findFirst({ where: { id, accountId } });
    if (!existing) throw new NotFoundException('分群不存在');

    const data: Prisma.SegmentUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.definition !== undefined) {
      await this.assertListRulesOwned(accountId, input.definition);
      data.definition = input.definition as unknown as Prisma.InputJsonValue;
      // Definition changed → cached count is meaningless. Wipe it so the UI
      // shows "—" until next preview/refresh; the alternative (silently
      // serving a count from the old definition) would be misleading.
      data.cachedCount = null;
      data.cachedAt = null;
    }

    try {
      const row = await this.prisma.segment.update({ where: { id }, data });
      return this.toView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('同名分群已存在');
      }
      throw err;
    }
  }

  /** A `list` rule references contactList UUIDs. Reject any that don't belong
   *  to this account so a definition can't target another tenant's lists. */
  private async assertListRulesOwned(
    accountId: string,
    definition: SegmentDefinition,
  ): Promise<void> {
    const listIds = [
      ...new Set(
        definition.rules
          .filter((r): r is Extract<typeof r, { type: 'list' }> => r.type === 'list')
          .flatMap((r) => r.values),
      ),
    ];
    if (listIds.length === 0) return;
    const owned = await this.prisma.contactList.count({
      where: { accountId, id: { in: listIds } },
    });
    if (owned !== listIds.length) {
      throw new BadRequestException('分群规则引用了无效的联系人列表');
    }
  }

  async remove(accountId: string, id: string): Promise<void> {
    const existing = await this.prisma.segment.findFirst({ where: { id, accountId } });
    if (!existing) throw new NotFoundException('分群不存在');

    // Refuse delete if any campaign still references this segment. Cascading
    // would silently break in-flight scheduled sends.
    const refCount = await this.prisma.campaignSegment.count({ where: { segmentId: id } });
    if (refCount > 0) {
      throw new ConflictException(`该分群被 ${refCount} 个活动引用,请先解除引用后再删除。`);
    }

    await this.prisma.segment.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a definition into the contactIds that match. Returns null if
   * the result would exceed EVENT_CONSTRAINT_HARD_CAP (caller decides whether
   * to throw or degrade). Used by:
   *   - preview (just calls .size + samples)
   *   - refresh (just calls .size, persists cachedCount)
   *   - Campaign send (turns ids into CampaignRecipient rows)
   */
  async resolveContactIds(accountId: string, def: SegmentDefinition): Promise<Set<string>> {
    const { pgWhere, eventConstraints } = compileSegment(def);

    // Apply event constraints first so we can narrow the PG query with `id IN`.
    // For 'has' constraints: intersect the event-derived contactId set.
    // For 'notHas' constraints: collect to exclude later.
    const hasSets: Set<string>[] = [];
    const notHasIds: string[] = [];

    for (const ec of eventConstraints) {
      const ids = await this.contactIdsFromEvent(accountId, ec);
      if (ec.mode === 'has') {
        hasSets.push(ids);
      } else {
        notHasIds.push(...ids);
      }
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
    const where: Prisma.ContactWhereInput = {
      accountId,
      ...pgWhere,
    };
    if (candidateIds) {
      // Bound the IN list defensively. With our hard cap above this can't
      // exceed 1M entries, but a single IN of 1M is also bad for PG —
      // see the chunked-scan comment in resolveLarge below.
      if (candidateIds.length > PRISMA_IN_BIND_SAFE_LIMIT) {
        return this.resolveLarge(where, candidateIds, notHasIds);
      }
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { id: { in: candidateIds } },
      ];
    }
    if (notHasIds.length > 0) {
      const dedup = [...new Set(notHasIds)];
      if (dedup.length > PRISMA_IN_BIND_SAFE_LIMIT) {
        return this.resolveLarge(where, candidateIds ?? null, dedup);
      }
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { NOT: { id: { in: dedup } } },
      ];
    }

    const rows = await this.prisma.contact.findMany({
      where,
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Slow path: when the IN list would be too large for one PG query we fall
   * back to scanning Contact in chunks. v1: simplest correct implementation,
   * not optimal — we just stream the full tenant contact set and filter
   * in-app. Caller code paths that hit this (very large event-derived sets)
   * are expected to be rare; revisit if/when they become hot.
   */
  private async resolveLarge(
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
    while (true) {
      const rows: { id: string }[] = await this.prisma.contact.findMany({
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
   * resulting recipient_ids back to contactIds via the PG campaign_recipients
   * table.
   *
   * Important: account_id is the leading sort key on email_events, so we
   * always filter on it first (perf + tenant isolation defence-in-depth).
   */
  private async contactIdsFromEvent(accountId: string, ec: EventConstraint): Promise<Set<string>> {
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
      rows = await this.ch.query<{ recipient_id: string }>(
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
      // nothing on the event branch. The user sees a 0 count instead of a
      // 500, and a subsequent refresh once CH is healthy will recover.
      this.logger.warn(
        `event evaluation failed (${ec.event}, ${ec.campaignId ?? 'any'}): ${(err as Error).message}`,
      );
      return new Set();
    }

    if (rows.length === 0) return new Set();
    if (rows.length > EVENT_CONSTRAINT_HARD_CAP) {
      this.logger.warn(
        `event constraint produced ${rows.length} rows > cap ${EVENT_CONSTRAINT_HARD_CAP}; truncating`,
      );
      rows = rows.slice(0, EVENT_CONSTRAINT_HARD_CAP);
    }

    const recipientIds = rows.map((r) => r.recipient_id);
    // recipientId → contactId via PG. campaign_recipients is the only
    // source of this mapping; archived/cold rows are NOT included here
    // (those recipients had their CampaignRecipient row purged ≥90d ago,
    // which is acceptable for "last N days" event lookups since N << 90).
    //
    // Chunk the IN-list: with EVENT_CONSTRAINT_HARD_CAP this set can hold up
    // to 1M ids, and a single `id IN (…)` would exceed PG's 65535 bind-param
    // limit (and bloat memory). 10k per query stays well under the ceiling.
    const contactIds = new Set<string>();
    for (let i = 0; i < recipientIds.length; i += EVENT_RECIPIENT_LOOKUP_CHUNK) {
      const links = await this.prisma.campaignRecipient.findMany({
        where: { accountId, id: { in: recipientIds.slice(i, i + EVENT_RECIPIENT_LOOKUP_CHUNK) } },
        select: { contactId: true },
      });
      for (const l of links) contactIds.add(l.contactId);
    }
    return contactIds;
  }

  // ---------------------------------------------------------------------------
  // Preview / refresh / paginated contacts (consumer-facing)
  // ---------------------------------------------------------------------------

  /**
   * Lightweight evaluation: count + first 5 contacts. Called as the user
   * builds rules in the editor with debouncing on the FE side.
   */
  async preview(accountId: string, def: SegmentDefinition): Promise<SegmentPreviewResult> {
    const ids = await this.resolveContactIds(accountId, def);
    if (ids.size === 0) return { count: 0, sample: [] };

    // We only need ANY 5 — fetch them in arbitrary order. With Set iteration
    // order being insertion order this is deterministic-enough for a preview.
    const sampleIds = [...ids].slice(0, 5);
    const sample = await this.prisma.contact.findMany({
      where: { id: { in: sampleIds } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    return { count: ids.size, sample };
  }

  /**
   * Persist the current cardinality so the segments list page can render
   * a fresh number without recomputing. Returns the new view (cached_count
   * is updated atomically).
   */
  async refresh(accountId: string, id: string): Promise<SegmentView> {
    const seg = await this.prisma.segment.findFirst({ where: { id, accountId } });
    if (!seg) throw new NotFoundException('分群不存在');

    const def = seg.definition as unknown as SegmentDefinition;
    const ids = await this.resolveContactIds(accountId, def);

    const updated = await this.prisma.segment.update({
      where: { id },
      data: { cachedCount: ids.size, cachedAt: new Date() },
    });
    return this.toView(updated);
  }

  async refreshAllSegments(): Promise<{
    total: number;
    refreshed: number;
    failed: number;
  }> {
    const segments = await this.prisma.segment.findMany({
      select: { id: true, accountId: true, definition: true },
      orderBy: { createdAt: 'asc' },
    });

    let refreshed = 0;
    let failed = 0;
    for (const seg of segments) {
      try {
        const ids = await this.resolveContactIds(
          seg.accountId,
          seg.definition as unknown as SegmentDefinition,
        );
        await this.prisma.segment.update({
          where: { id: seg.id },
          data: { cachedCount: ids.size, cachedAt: new Date() },
        });
        refreshed += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(`daily segment refresh failed for ${seg.id}: ${(err as Error).message}`);
      }
    }

    return { total: segments.length, refreshed, failed };
  }

  async listContacts(
    accountId: string,
    id: string,
    query: ListSegmentContactsQuery,
  ): Promise<SegmentContactsPage> {
    const seg = await this.prisma.segment.findFirst({ where: { id, accountId } });
    if (!seg) throw new NotFoundException('分群不存在');

    const def = seg.definition as unknown as SegmentDefinition;
    const ids = await this.resolveContactIds(accountId, def);
    const total = ids.size;

    if (total === 0) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    }

    // Stable pagination across calls: sort the ids before slicing. This is
    // O(n log n) on the matched set which can get expensive for huge
    // segments, but the UI cap is pageSize <= 200 so for now we accept it.
    const sorted = [...ids].sort();
    const start = (query.page - 1) * query.pageSize;
    const slice = sorted.slice(start, start + query.pageSize);

    const rows = await this.prisma.contact.findMany({
      where: { id: { in: slice } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        subscriptionStatus: true,
        createdAt: true,
      },
    });
    // Maintain the sorted-id order in the response.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = slice
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({
        id: r.id,
        email: r.email,
        firstName: r.firstName,
        lastName: r.lastName,
        subscriptionStatus: r.subscriptionStatus,
        createdAt: r.createdAt.toISOString(),
      }));

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private toView(r: {
    id: string;
    name: string;
    description: string | null;
    definition: Prisma.JsonValue;
    cachedCount: number | null;
    cachedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): SegmentView {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      definition: r.definition as unknown as SegmentDefinition,
      cachedCount: r.cachedCount,
      cachedAt: r.cachedAt ? r.cachedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
