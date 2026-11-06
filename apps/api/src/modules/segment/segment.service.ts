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
import { countSegment, pageSegment, planSegment, type SegmentPlan } from '@sendmast/audience';

@Injectable()
export class SegmentService {
  private readonly logger = new Logger(SegmentService.name);
  private readonly inFlightPlans = new Map<string, Promise<SegmentPlan>>();

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
   * Compile + evaluate the derived (ClickHouse / order) parts of a segment
   * into a SegmentPlan. Concurrent identical requests (e.g. the editor's
   * debounced preview while a refresh runs) share one in-flight evaluation.
   * Counting / paging on the plan never loads the whole audience.
   */
  private plan(accountId: string, def: SegmentDefinition): Promise<SegmentPlan> {
    const key = `${accountId}:${JSON.stringify(def)}`;
    const existing = this.inFlightPlans.get(key);
    if (existing) return existing;
    const evaluation = planSegment(this.audienceCtx(), accountId, def);
    this.inFlightPlans.set(key, evaluation);
    const cleanup = () => {
      if (this.inFlightPlans.get(key) === evaluation) this.inFlightPlans.delete(key);
    };
    void evaluation.then(cleanup, cleanup);
    return evaluation;
  }

  private audienceCtx() {
    return { prisma: this.prisma, ch: this.ch, logger: this.logger };
  }

  /** Number of contacts matching a definition (COUNT queries only). */
  async countContacts(accountId: string, def: SegmentDefinition): Promise<number> {
    return countSegment(this.audienceCtx(), await this.plan(accountId, def));
  }

  // ---------------------------------------------------------------------------
  // Preview / refresh / paginated contacts (consumer-facing)
  // ---------------------------------------------------------------------------

  /**
   * Lightweight evaluation: count + first 5 contacts. Called as the user
   * builds rules in the editor with debouncing on the FE side.
   */
  async preview(accountId: string, def: SegmentDefinition): Promise<SegmentPreviewResult> {
    const plan = await this.plan(accountId, def);
    const [count, sample] = await Promise.all([
      countSegment(this.audienceCtx(), plan),
      pageSegment<{ id: string; email: string; firstName: string | null; lastName: string | null }>(
        this.audienceCtx(),
        plan,
        1,
        5,
        { id: true, email: true, firstName: true, lastName: true },
      ),
    ]);
    return { count, sample };
  }

  /**
   * Persist the current cardinality so the segments list page can render
   * a fresh number without recomputing.
   */
  async refresh(accountId: string, id: string): Promise<SegmentView> {
    const seg = await this.prisma.segment.findFirst({ where: { id, accountId } });
    if (!seg) throw new NotFoundException('分群不存在');
    const count = await this.countContacts(
      accountId,
      seg.definition as unknown as SegmentDefinition,
    );
    const updated = await this.prisma.segment.update({
      where: { id },
      data: { cachedCount: count, cachedAt: new Date() },
    });
    return this.toView(updated);
  }

  async listContacts(
    accountId: string,
    id: string,
    query: ListSegmentContactsQuery,
  ): Promise<SegmentContactsPage> {
    const seg = await this.prisma.segment.findFirst({ where: { id, accountId } });
    if (!seg) throw new NotFoundException('分群不存在');

    const plan = await this.plan(accountId, seg.definition as unknown as SegmentDefinition);
    // Stable order = contact id (keyset-friendly); only the requested page
    // is read, never the whole audience.
    const [total, rows] = await Promise.all([
      countSegment(this.audienceCtx(), plan),
      pageSegment<{
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        subscriptionStatus: SegmentContactsPage['items'][number]['subscriptionStatus'];
        createdAt: Date;
      }>(this.audienceCtx(), plan, query.page, query.pageSize, {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        subscriptionStatus: true,
        createdAt: true,
      }),
    ]);
    const items = rows.map((r) => ({
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
