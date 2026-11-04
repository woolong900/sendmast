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
import { resolveSegmentContactIds } from '@sendmast/audience';

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
   * the result would exceed DERIVED_CONSTRAINT_HARD_CAP (caller decides whether
   * to throw or degrade). Used by:
   *   - preview (just calls .size + samples)
   *   - refresh (just calls .size, persists cachedCount)
   *   - Campaign send (turns ids into CampaignRecipient rows)
   */
  async resolveContactIds(accountId: string, def: SegmentDefinition): Promise<Set<string>> {
    // Evaluation lives in @sendmast/audience so worker-sender (campaign
    // materialisation) and the API (preview / refresh) can never disagree on
    // who is in a segment.
    return resolveSegmentContactIds(
      { prisma: this.prisma, ch: this.ch, logger: this.logger },
      accountId,
      def,
    );
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
