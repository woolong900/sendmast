import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../../common/queue/queue.service';
import { ClickHouseService } from '../../common/clickhouse/clickhouse.service';
import { AuthService } from '../auth/auth.service';
import { SegmentService } from '../segment/segment.service';
import { TemplateService } from '../template/template.service';
import { renderMjml } from '../template/mjml-renderer';
import {
  QUEUE_NAMES,
  type CreateCampaignInput,
  type ListCampaignsQuery,
  type ListRecipientsQuery,
  type ListRecipientsResponse,
  type RecipientView,
  type UpdateCampaignInput,
} from '@sendmast/shared';

interface ContactNamePair {
  firstName: string | null;
  lastName: string | null;
}

function toRecipientView(
  r: {
    id: string;
    email: string;
    status: string;
    messageId: string | null;
    errorMessage: string | null;
    sentAt: Date | null;
    createdAt: Date;
    contactId?: string;
  },
  contactName?: ContactNamePair | null,
  eventTime?: Date | string | null,
): RecipientView {
  const evt =
    eventTime instanceof Date
      ? eventTime.toISOString()
      : eventTime ?? (r.sentAt ? r.sentAt.toISOString() : null);
  return {
    id: r.id,
    email: r.email,
    firstName: contactName?.firstName ?? null,
    lastName: contactName?.lastName ?? null,
    status: r.status,
    messageId: r.messageId,
    errorMessage: r.errorMessage,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    eventTime: evt,
    userAgent: null,
    linkUrl: null,
    deliveredAt: null,
    reason: null,
    bounceType: null,
  };
}

/**
 * Pull the bounce classification + human-readable reason out of a raw_meta
 * payload. We have two producers writing into the same CH column with
 * different shapes:
 *
 *   1) ACS bounce events (worker-events, from Event Grid):
 *        { status: "Bounced" | ..., deliveryStatusDetails: { statusMessage: "550 ..." }, ... }
 *
 *   2) Self-tracked unsubscribe events (tracking.service.ts):
 *        { reason: "Too many emails" }
 *
 * The parser yields `bounceType` only for shape (1) and `reason` for either
 * shape, preferring the ACS field when both are present. Unknown / missing
 * payloads degrade to nulls instead of throwing.
 */
function parseRawMetaReason(rawMeta: string | null): {
  bounceType: string | null;
  reason: string | null;
} {
  if (!rawMeta) return { bounceType: null, reason: null };
  try {
    const obj = JSON.parse(rawMeta) as {
      status?: unknown;
      deliveryStatusDetails?: { statusMessage?: unknown };
      reason?: unknown;
    };
    const status = typeof obj.status === 'string' ? obj.status : null;
    const acsReason =
      typeof obj.deliveryStatusDetails?.statusMessage === 'string'
        ? obj.deliveryStatusDetails.statusMessage
        : null;
    const selfReason =
      typeof obj.reason === 'string' && obj.reason.trim().length > 0
        ? obj.reason
        : null;
    return { bounceType: status, reason: acsReason ?? selfReason };
  } catch {
    return { bounceType: null, reason: null };
  }
}

/**
 * Bulk-fetch firstName/lastName for a list of contactIds. We do this as a
 * separate query (instead of an ORM include) because campaign_recipients
 * doesn't declare a Prisma relation to Contact in the schema. Single
 * indexed PK lookup batched via IN, so it's cheap.
 */
async function fetchContactNames(
  prisma: PrismaService,
  contactIds: string[],
): Promise<Map<string, ContactNamePair>> {
  if (contactIds.length === 0) return new Map();
  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(
    contacts.map((c) => [c.id, { firstName: c.firstName, lastName: c.lastName }]),
  );
}

/**
 * Map UI-facing dimension names to PG RecipientStatus filters. `invalid` and
 * `bounced` are intentionally absent here — they're served from ClickHouse
 * because the per-event distinction lives in email_events, not in PG.
 */
const PG_STATUS_BY_DIMENSION: Partial<
  Record<import('@sendmast/shared').RecipientDimension, 'sent' | 'failed'>
> = {
  sent: 'sent',
  failed: 'failed',
};

/**
 * Map UI-facing dimension names to (CH event_type, optional bounce_kind filter).
 * `invalid` filters bounce_kind='hard' so the 无效邮箱 tab shows only
 * permanent failures; `bounced` shows all bounces.
 */
const CH_EVENT_BY_DIMENSION: Partial<
  Record<
    import('@sendmast/shared').RecipientDimension,
    { eventType: string; bounceKind?: 'hard' | 'soft' }
  >
> = {
  delivered: { eventType: 'delivered' },
  opened: { eventType: 'open' },
  clicked: { eventType: 'click' },
  bounced: { eventType: 'bounce' },
  invalid: { eventType: 'bounce', bounceKind: 'hard' },
  unsubscribed: { eventType: 'unsubscribe' },
  complained: { eventType: 'complaint' },
};

@Injectable()
export class CampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly templates: TemplateService,
    private readonly ch: ClickHouseService,
    private readonly auth: AuthService,
    private readonly segments: SegmentService,
  ) {}

  async list(accountId: string, query: ListCampaignsQuery) {
    const where: Prisma.CampaignWhereInput = { accountId };
    if (query.status) where.status = query.status;
    if (query.search)
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { subject: { contains: query.search, mode: 'insensitive' } },
      ];
    if (query.createdFrom ?? query.createdTo) {
      where.createdAt = {};
      if (query.createdFrom) where.createdAt.gte = new Date(query.createdFrom);
      if (query.createdTo) where.createdAt.lte = new Date(query.createdTo);
    }

    const skip = (query.page - 1) * query.pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.pageSize,
        select: {
          id: true,
          name: true,
          subject: true,
          status: true,
          fromName: true,
          fromEmail: true,
          // `html` is intentionally NOT selected for the list response.
          // Returning the rendered HTML for every campaign on the page
          // produced multi-MB payloads and forced the client to mount a
          // sandboxed iframe per row, causing intermittent multi-second
          // freezes on the campaign list. We now ship only the lightweight
          // `thumbnail` URL; the hover preview (and detail page) lazy-fetch
          // the full HTML through GET /api/campaigns/:id.
          thumbnail: true,
          totalRecipients: true,
          scheduledAt: true,
          sentAt: true,
          createdAt: true,
          lists: { select: { list: { select: { id: true, name: true } } } },
          segments: { select: { segment: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    const stats = await this.collectListStats(accountId, rows.map((r) => r.id));
    const items = rows.map((r) => ({
      ...r,
      lists: r.lists.map((cl) => cl.list),
      segments: r.segments.map((cs) => cs.segment),
      stats: stats[r.id] ?? { sent: 0, opened: 0, clicked: 0 },
    }));

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Fetch sent (PG) + unique open/click (ClickHouse) counts for many campaigns at once. */
  private async collectListStats(
    accountId: string,
    ids: string[],
  ): Promise<Record<string, { sent: number; opened: number; clicked: number }>> {
    if (ids.length === 0) return {};

    const out: Record<string, { sent: number; opened: number; clicked: number }> = {};
    for (const id of ids) out[id] = { sent: 0, opened: 0, clicked: 0 };

    // Sent count from Postgres — one grouped query for all campaigns.
    const sentRows = await this.prisma.campaignRecipient.groupBy({
      by: ['campaignId'],
      where: { accountId, campaignId: { in: ids }, status: 'sent' },
      _count: { _all: true },
    });
    for (const r of sentRows) out[r.campaignId].sent = r._count._all;

    // Unique opens / clicks from ClickHouse — one grouped query for all campaigns.
    // account_id is the leading sort key; filtering on it first lets CH skip
    // unrelated tenant data AND enforces tenant isolation defence-in-depth.
    // Best-effort; if CH is down we still return PG-derived sent counts.
    try {
      const rows = await this.ch.query<{
        campaign_id: string;
        event_type: string;
        uniques: string;
      }>(
        `SELECT toString(campaign_id) AS campaign_id,
                event_type,
                toString(uniqExact(recipient_id)) AS uniques
         FROM sendmast.email_events
         WHERE account_id = {acc:UUID}
           AND campaign_id IN ({ids:Array(UUID)})
           AND event_type IN ('open','click')
         GROUP BY campaign_id, event_type`,
        { acc: accountId, ids },
      );
      for (const r of rows) {
        const target = out[r.campaign_id];
        if (!target) continue;
        const n = Number(r.uniques);
        if (r.event_type === 'open') target.opened = n;
        else if (r.event_type === 'click') target.clicked = n;
      }
    } catch (err) {
      console.warn('Campaign list stats — ClickHouse unavailable:', err);
    }

    return out;
  }

  async statusCounts(accountId: string) {
    const groups = await this.prisma.campaign.groupBy({
      by: ['status'],
      where: { accountId },
      _count: { _all: true },
    });
    const out: Record<string, number> = { sending: 0, scheduled: 0, sent: 0, draft: 0 };
    for (const g of groups) out[g.status] = g._count._all;
    return out;
  }

  async get(accountId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({
      where: { id, accountId },
      include: {
        lists: { include: { list: true } },
        segments: { include: { segment: true } },
      },
    });
    if (!c) throw new NotFoundException('活动不存在');
    return c;
  }

  /**
   * Paginated recipient listing with transparent hot/cold routing.
   *
   * - "Hot" path: campaign hasn't been archived yet → query Postgres.
   * - "Cold" path: campaign has been moved to ClickHouse → query CH archive.
   *
   * Cursor is the last seen `id` (UUID). The same cursor format works for
   * both backends because they both order by id ASC. The response includes
   * `source` so callers can show "(归档)" badges if they want.
   */
  async listRecipients(
    accountId: string,
    campaignId: string,
    query: ListRecipientsQuery,
  ): Promise<ListRecipientsResponse> {
    // Tenant scoping: confirm the campaign belongs to this account before
    // anything else, otherwise we'd leak archived data across tenants.
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, accountId },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundException('活动不存在');

    // sales 维度暂无订单系统接入,直接返回空表 + empty source so the UI knows.
    if (query.dimension === 'sales') {
      return { source: 'empty', rows: [], nextCursor: null, total: null };
    }

    // Event-based dimensions (delivered/open/click/bounce/...) are answered
    // straight out of ClickHouse email_events regardless of archive status —
    // we want to show "who opened" even after the recipients table is gone.
    const chMapping = CH_EVENT_BY_DIMENSION[query.dimension];
    if (chMapping) {
      return this.listRecipientsFromEvents(
        accountId,
        campaignId,
        query,
        chMapping.eventType,
        chMapping.bounceKind,
      );
    }

    // Otherwise we're on a PG dimension (sent/failed) — fall back to status
    // filter on either the hot table or the cold archive.
    const archived = await this.prisma.campaignArchiveState.findUnique({
      where: { campaignId },
      select: { campaignId: true },
    });
    const status = PG_STATUS_BY_DIMENSION[query.dimension] ?? query.status;

    return archived
      ? this.listRecipientsFromArchive(accountId, campaignId, query, status)
      : this.listRecipientsFromHot(campaignId, query, status);
  }

  private async listRecipientsFromHot(
    campaignId: string,
    q: ListRecipientsQuery,
    status: 'sent' | 'failed' | 'pending' | 'queued' | 'skipped' | undefined,
  ): Promise<ListRecipientsResponse> {
    const where: Prisma.CampaignRecipientWhereInput = {
      campaignId,
      ...(status ? { status } : {}),
    };
    // We do a small COUNT here so the UI can show a total. Cheap because
    // (campaign_id, status) is well-indexed and per-campaign cardinality is
    // bounded; if you ever see this in slow logs swap it for an estimate.
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.campaignRecipient.count({ where }),
      this.prisma.campaignRecipient.findMany({
        where,
        orderBy: { id: 'asc' },
        // take pageSize+1 so we can compute `nextCursor` without re-COUNT.
        take: q.pageSize + 1,
        ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
      }),
    ]);
    const hasMore = rows.length > q.pageSize;
    const page = hasMore ? rows.slice(0, q.pageSize) : rows;
    const names = await fetchContactNames(
      this.prisma,
      page.map((r) => r.contactId),
    );
    return {
      source: 'hot',
      rows: page.map((r) => toRecipientView(r, names.get(r.contactId))),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      total,
    };
  }

  private async listRecipientsFromArchive(
    accountId: string,
    campaignId: string,
    q: ListRecipientsQuery,
    status: 'sent' | 'failed' | 'pending' | 'queued' | 'skipped' | undefined,
  ): Promise<ListRecipientsResponse> {
    // FINAL forces a sort-merge of any not-yet-merged duplicate rows from
    // partial archive runs (see worker-sender/src/archive.ts). Adds latency
    // proportional to pending parts; for our scale (≤1M recipients per
    // campaign, archive runs once per day) this is negligible.
    // NOTE: archive table doesn't store first_name/last_name (we only kept
    // email at archive time). Name columns are intentionally null here.
    const params: Record<string, unknown> = {
      acc: accountId,
      cid: campaignId,
      lim: q.pageSize + 1,
    };
    let where = 'account_id = {acc:UUID} AND campaign_id = {cid:UUID}';
    if (q.cursor) {
      where += ' AND id > {cursor:UUID}';
      params.cursor = q.cursor;
    }
    if (status) {
      where += ' AND status = {status:String}';
      params.status = status;
    }
    const rows = await this.ch.query<{
      id: string;
      email: string;
      status: string;
      message_id: string | null;
      error_message: string | null;
      sent_at: string | null;
      created_at: string;
    }>(
      `SELECT id, email, status, message_id, error_message, sent_at, created_at
       FROM sendmast.campaign_recipients_archive FINAL
       WHERE ${where}
       ORDER BY id ASC
       LIMIT {lim:UInt32}`,
      params,
    );
    const hasMore = rows.length > q.pageSize;
    const page = hasMore ? rows.slice(0, q.pageSize) : rows;
    return {
      source: 'archived',
      rows: page.map((r) => ({
        id: r.id,
        email: r.email,
        firstName: null,
        lastName: null,
        status: r.status,
        messageId: r.message_id,
        errorMessage: r.error_message,
        sentAt: r.sent_at,
        createdAt: r.created_at,
        eventTime: r.sent_at,
        userAgent: null,
        linkUrl: null,
        deliveredAt: null,
        reason: null,
        bounceType: null,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      total: null,
    };
  }

  /**
   * Resolve recipients via ClickHouse email_events for the given event_type.
   * Returns one row per distinct recipient_id with its latest event_time as
   * the eventTime column. For each recipient we then pull email + name from
   * PG (or fall back to the archive table when the recipient row is gone).
   *
   * Pagination uses the latest event_time as a (non-strict) cursor; this is
   * good enough for human browsing but may double-count an edge row across
   * pages if many events share the same millisecond. Acceptable trade-off
   * for the UI that paginates 50–100 rows at a time.
   */
  private async listRecipientsFromEvents(
    accountId: string,
    campaignId: string,
    q: ListRecipientsQuery,
    eventType: string,
    bounceKindFilter?: 'hard' | 'soft',
  ): Promise<ListRecipientsResponse> {
    const params: Record<string, unknown> = {
      acc: accountId,
      cid: campaignId,
      et: eventType,
      lim: q.pageSize + 1,
    };
    let cursorClause = '';
    if (q.cursor) {
      cursorClause = 'AND ts < parseDateTime64BestEffort({cursor:String}, 3)';
      params.cursor = q.cursor;
    }
    let bounceClause = '';
    if (bounceKindFilter) {
      bounceClause = ' AND bounce_kind = {bk:String}';
      params.bk = bounceKindFilter;
    }

    // argMax(x, event_time) returns x at the latest event for the recipient.
    // We pull UA / link_url / raw_meta / bounce_kind in one shot so each row
    // is self-contained — the UI decides which columns to render.
    interface EventGroupRow {
      recipient_id: string;
      ts: string;
      user_agent: string | null;
      link_url: string | null;
      raw_meta: string | null;
      bounce_kind: string;
    }

    let rows: EventGroupRow[] = [];
    try {
      rows = await this.ch.query<EventGroupRow>(
        `SELECT
           recipient_id,
           max(event_time) AS ts,
           argMax(user_agent, event_time) AS user_agent,
           argMax(link_url, event_time) AS link_url,
           argMax(raw_meta, event_time) AS raw_meta,
           argMax(bounce_kind, event_time) AS bounce_kind
         FROM sendmast.email_events
         WHERE account_id = {acc:UUID}
           AND campaign_id = {cid:UUID}
           AND event_type = {et:String}${bounceClause}
         GROUP BY recipient_id
         HAVING 1=1 ${cursorClause}
         ORDER BY ts DESC
         LIMIT {lim:UInt32}`,
        params,
      );
    } catch (err) {
      // ClickHouse unreachable → degrade to empty rather than 500. The UI
      // already shows the analytics card so users know events exist.
      console.warn('listRecipientsFromEvents: CH query failed', err);
      return { source: 'events', rows: [], nextCursor: null, total: null };
    }

    if (rows.length === 0) {
      return { source: 'events', rows: [], nextCursor: null, total: null };
    }

    const hasMore = rows.length > q.pageSize;
    const page = hasMore ? rows.slice(0, q.pageSize) : rows;
    const ids = page.map((r) => r.recipient_id);

    // Try PG first; missing ones (because the campaign was archived) come
    // from the cold archive table.
    const hot = await this.prisma.campaignRecipient.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, contactId: true, sentAt: true },
    });
    interface HotMeta {
      email: string;
      contactId: string | null;
      sentAt: Date | string | null;
    }
    const byId = new Map<string, HotMeta>(
      hot.map((r) => [
        r.id,
        { email: r.email, contactId: r.contactId, sentAt: r.sentAt },
      ]),
    );

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const cold = await this.ch.query<{
        id: string;
        email: string;
        sent_at: string | null;
      }>(
        `SELECT id, email, sent_at
         FROM sendmast.campaign_recipients_archive FINAL
         WHERE account_id = {acc:UUID}
           AND campaign_id = {cid:UUID}
           AND id IN ({ids:Array(UUID)})`,
        { acc: accountId, cid: campaignId, ids: missing },
      );
      for (const c of cold) {
        // Archive table doesn't carry contact_id — name will fall back to null.
        byId.set(c.id, { email: c.email, contactId: null, sentAt: c.sent_at });
      }
    }

    const contactIds = [...byId.values()]
      .map((m) => m.contactId)
      .filter((x): x is string => !!x);
    const names = await fetchContactNames(this.prisma, contactIds);

    // For the 'opened' tab the UI shows a "送达时间" column. We need to fetch
    // the per-recipient max(delivered) event time from CH for the visible
    // page only. One round-trip with IN, scoped to the same campaign.
    let deliveredById = new Map<string, string>();
    if (eventType === 'open') {
      try {
        const dRows = await this.ch.query<{ recipient_id: string; ts: string }>(
          `SELECT recipient_id, max(event_time) AS ts
           FROM sendmast.email_events
           WHERE account_id = {acc:UUID}
             AND campaign_id = {cid:UUID}
             AND event_type = 'delivered'
             AND recipient_id IN ({ids:Array(UUID)})
           GROUP BY recipient_id`,
          { acc: accountId, cid: campaignId, ids },
        );
        deliveredById = new Map(dRows.map((r) => [r.recipient_id, r.ts]));
      } catch {
        // Best-effort enrichment; leave deliveredAt null if CH hiccups here.
      }
    }

    const view: RecipientView[] = page.map((r) => {
      const meta = byId.get(r.recipient_id);
      const name = meta?.contactId ? names.get(meta.contactId) : null;
      const sentAtIso =
        meta?.sentAt instanceof Date
          ? meta.sentAt.toISOString()
          : (meta?.sentAt as string | null) ?? null;
      const parsed = parseRawMetaReason(r.raw_meta);
      // Prefer the dedicated bounce_kind column when present (set by the
      // webhook layer); fall back to the raw status string for older rows
      // ingested before the column existed. Localised for the UI.
      const bounceType =
        r.bounce_kind === 'hard'
          ? '硬退'
          : r.bounce_kind === 'soft'
            ? '软退'
            : parsed.bounceType;
      return {
        id: r.recipient_id,
        email: meta?.email ?? '(unknown)',
        firstName: name?.firstName ?? null,
        lastName: name?.lastName ?? null,
        status: 'sent',
        messageId: null,
        errorMessage: null,
        sentAt: sentAtIso,
        createdAt: r.ts,
        eventTime: r.ts,
        userAgent: r.user_agent,
        linkUrl: r.link_url,
        deliveredAt: deliveredById.get(r.recipient_id) ?? null,
        reason: parsed.reason,
        bounceType,
      };
    });

    return {
      source: 'events',
      rows: view,
      nextCursor: hasMore ? page[page.length - 1].ts : null,
      total: null,
    };
  }

  async create(accountId: string, input: CreateCampaignInput) {
    // Gate: tenant must be fully active. Pending-activation users can do
    // everything else (browse templates, build the email, manage contacts)
    // but cannot persist a campaign until they verify their email.
    await this.auth.assertActive(accountId);

    const { mjml, html, designJson } = await this.resolveBody(accountId, {
      templateId: input.templateId,
      mjml: input.mjml,
      html: input.html,
      designJson: input.designJson,
    });

    await this.assertTargetsExist(accountId, input.listIds, input.segmentIds);

    const status = input.scheduledAt ? 'scheduled' : 'draft';

    return this.prisma.campaign.create({
      data: {
        accountId,
        name: input.name,
        subject: input.subject,
        preheader: input.preheader,
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        replyTo: input.replyTo,
        templateId: input.templateId,
        mjml,
        html,
        thumbnail: input.thumbnail,
        designJson: designJson as Prisma.InputJsonValue | undefined,
        editorMode: input.editorMode,
        status,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        utmEnabled: input.utmEnabled,
        utmSource: input.utmSource,
        utmMedium: input.utmMedium,
        utmCampaign: input.utmCampaign,
        trackClicks: input.trackClicks,
        lists: { create: input.listIds.map((listId) => ({ listId })) },
        segments: { create: input.segmentIds.map((segmentId) => ({ segmentId })) },
      },
    });
  }

  /**
   * Validate that every listId / segmentId in the input belongs to this
   * tenant. Throws BadRequestException on the first mismatch. We don't
   * enforce "at least one" here — empty drafts are allowed; the send()
   * path is where the audience must be non-empty.
   */
  private async assertTargetsExist(
    accountId: string,
    listIds: string[],
    segmentIds: string[],
  ): Promise<void> {
    if (listIds.length > 0) {
      const lists = await this.prisma.contactList.findMany({
        where: { accountId, id: { in: listIds } },
        select: { id: true },
      });
      if (lists.length !== listIds.length) {
        throw new BadRequestException('部分联系人列表不存在');
      }
    }
    if (segmentIds.length > 0) {
      const segs = await this.prisma.segment.findMany({
        where: { accountId, id: { in: segmentIds } },
        select: { id: true },
      });
      if (segs.length !== segmentIds.length) {
        throw new BadRequestException('部分分群不存在');
      }
    }
  }

  async update(accountId: string, id: string, input: UpdateCampaignInput) {
    const c = await this.prisma.campaign.findFirst({ where: { id, accountId } });
    if (!c) throw new NotFoundException();
    if (c.status !== 'draft' && c.status !== 'scheduled') {
      throw new ConflictException('已发送或正在发送的活动无法编辑');
    }

    // Resolve body if templateId / mjml / html / designJson provided.
    let mjml: string | null | undefined;
    let html: string | null | undefined;
    let designJson: unknown | undefined;
    if (
      input.templateId !== undefined ||
      input.mjml !== undefined ||
      input.html !== undefined ||
      input.designJson !== undefined
    ) {
      const resolved = await this.resolveBody(accountId, {
        templateId: input.templateId ?? c.templateId ?? undefined,
        mjml: input.mjml,
        html: input.html,
        designJson: input.designJson,
      });
      mjml = resolved.mjml;
      html = resolved.html;
      designJson = resolved.designJson;
    }

    await this.assertTargetsExist(
      accountId,
      input.listIds ?? [],
      input.segmentIds ?? [],
    );

    return this.prisma.$transaction(async (tx) => {
      if (input.listIds) {
        await tx.campaignList.deleteMany({ where: { campaignId: id } });
        await tx.campaignList.createMany({
          data: input.listIds.map((listId) => ({ campaignId: id, listId })),
        });
      }
      if (input.segmentIds) {
        await tx.campaignSegment.deleteMany({ where: { campaignId: id } });
        await tx.campaignSegment.createMany({
          data: input.segmentIds.map((segmentId) => ({ campaignId: id, segmentId })),
        });
      }

      return tx.campaign.update({
        where: { id },
        data: {
          name: input.name,
          subject: input.subject,
          preheader: input.preheader,
          fromName: input.fromName,
          fromEmail: input.fromEmail,
          replyTo: input.replyTo,
          templateId: input.templateId,
          mjml,
          html,
          thumbnail: input.thumbnail,
          designJson: designJson as Prisma.InputJsonValue | undefined,
          editorMode: input.editorMode,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
          utmEnabled: input.utmEnabled,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          trackClicks: input.trackClicks,
        },
        include: {
          lists: { include: { list: true } },
          segments: { include: { segment: true } },
        },
      });
    });
  }

  /**
   * Resolve mjml/html/designJson for a campaign body. Order of precedence:
   * caller-provided html > caller-provided mjml > template lookup. Returns
   * nulls when nothing is provided (allowed for drafts).
   */
  private async resolveBody(
    accountId: string,
    input: {
      templateId?: string | null;
      mjml?: string | null;
      html?: string | null;
      designJson?: unknown;
    },
  ): Promise<{ mjml: string | null; html: string | null; designJson: unknown | null }> {
    if (input.html != null) {
      return {
        mjml: input.mjml ?? null,
        html: input.html,
        designJson: input.designJson ?? null,
      };
    }
    if (input.mjml) {
      return {
        mjml: input.mjml,
        html: renderMjml(input.mjml).html,
        designJson: input.designJson ?? null,
      };
    }
    if (input.templateId) {
      const tpl = await this.prisma.emailTemplate.findFirst({
        where: { id: input.templateId, OR: [{ scope: 'system' }, { accountId }] },
      });
      if (!tpl) throw new NotFoundException('模板不存在');
      return {
        mjml: tpl.mjml,
        html: tpl.html,
        designJson: input.designJson ?? tpl.designJson,
      };
    }
    return { mjml: null, html: null, designJson: input.designJson ?? null };
  }

  async send(accountId: string, id: string) {
    // Gate: same as create — sending an existing draft from a tenant that
    // hasn't activated (or got suspended after creating) is also blocked.
    await this.auth.assertActive(accountId);

    // Quota gate: refuse to even enter the sending state when remaining=0.
    // Without this check the campaign would flip to `status='sending'` and
    // sit there forever — the worker tick is also quota-aware (it will
    // force-finalize stuck campaigns) but bouncing the request here is the
    // honest behaviour the UI hints at via its disabled send button.
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { sendQuotaRemaining: true },
    });
    if (!account || account.sendQuotaRemaining <= 0) {
      throw new BadRequestException(
        '发送额度为 0,无法发送活动。请先购买额度。',
      );
    }

    // Read-only pre-flight: validates fields that don't participate in the
    // status race (html body, verified sender domain, non-empty audience).
    const c = await this.prisma.campaign.findFirst({
      where: { id, accountId },
      include: { lists: true, segments: true },
    });
    if (!c) throw new NotFoundException();
    if (!c.html) throw new BadRequestException('活动尚未设置邮件正文');

    const senderDomain = c.fromEmail.split('@')[1];
    const verified = await this.prisma.senderDomain.findFirst({
      where: { accountId, domain: senderDomain, status: 'verified' },
      include: { acsAccount: true },
    });
    if (!verified) {
      throw new BadRequestException(`寄件域名 ${senderDomain} 尚未验证`);
    }
    if (!verified.acsAccount) {
      throw new BadRequestException(
        `Sender domain ${senderDomain} has no ACS account assigned`,
      );
    }
    if (verified.acsAccount.status !== 'active') {
      throw new BadRequestException(
        `ACS account ${verified.acsAccount.name} is ${verified.acsAccount.status}`,
      );
    }

    // Audience resolution & recipient materialisation strategy:
    //
    //   - List-only campaigns (no segments): cheap pre-flight here ("is at
    //     least one subscribed contact reachable?") then punt the heavy
    //     `findMany(contacts) → INSERT(recipients)` work to the dispatch
    //     worker, which streams it in cursor-paginated batches.
    //
    //   - Segment-enabled campaigns: keep doing the full resolution here —
    //     the worker is list-only by design (it doesn't know how to compile
    //     SegmentDefinition + reach into ClickHouse for event constraints),
    //     and pulling segment evaluation into the worker would mean either
    //     a new shared package or duplicating ~100 lines of logic. Punt
    //     that refactor; sub-100k segment audiences finish well within the
    //     existing API budget anyway.
    //
    // The trade-off was "send() latency scales with audience size — fine
    // for v1 (< ~100k)". 342k+ list audiences blew past that and that's
    // what motivates this split.
    const hasSegments = c.segments.length > 0;

    const isFuture = !!(c.scheduledAt && c.scheduledAt > new Date());
    const nextStatus = isFuture ? 'scheduled' : 'sending';

    if (hasSegments) {
      // Slow path: resolve & materialise here so the worker can dispatch
      // immediately without needing segment evaluation logic.
      const audience = await this.resolveAudience(
        accountId,
        c.lists.map((l) => l.listId),
        c.segments.map((s) => s.segmentId),
      );
      if (audience.length === 0) {
        throw new BadRequestException('所选列表/分群中没有可发送的联系人');
      }

      const swap = await this.prisma.campaign.updateMany({
        where: {
          id: c.id,
          accountId,
          status: { notIn: ['sending', 'sent', 'canceled'] },
        },
        data: {
          status: nextStatus,
          totalRecipients: audience.length,
          sendingStartedAt: isFuture ? null : new Date(),
        },
      });
      if (swap.count === 0) throw new ConflictException('当前活动状态不允许发送');

      await this.materialiseRecipients(c.id, accountId, audience);
    } else {
      // Fast path: cheap pre-flight only. A single LIMIT-1 query on the
      // (accountId, listId, subscriptionStatus) index — sub-ms even on huge
      // lists — gives the user immediate "your audience is empty" feedback
      // without paying for the full scan.
      const listIds = c.lists.map((l) => l.listId);
      const hasAny = await this.prisma.contact.findFirst({
        where: {
          accountId,
          subscriptionStatus: 'subscribed',
          memberships: { some: { listId: { in: listIds } } },
        },
        select: { id: true },
      });
      if (!hasAny) {
        throw new BadRequestException('所选列表/分群中没有可发送的联系人');
      }

      // Status compare-and-swap. totalRecipients stays at 0 — the worker
      // sets the real count after streaming the recipient rows in.
      const swap = await this.prisma.campaign.updateMany({
        where: {
          id: c.id,
          accountId,
          status: { notIn: ['sending', 'sent', 'canceled'] },
        },
        data: {
          status: nextStatus,
          sendingStartedAt: isFuture ? null : new Date(),
        },
      });
      if (swap.count === 0) throw new ConflictException('当前活动状态不允许发送');
    }

    const delay = isFuture ? c.scheduledAt!.getTime() - Date.now() : 0;
    await this.queue.add(
      QUEUE_NAMES.SEND_CAMPAIGN,
      'dispatch',
      { campaignId: c.id, accountId },
      { delay, removeOnComplete: true },
    );

    return { ok: true };
  }

  /**
   * Audience = ∪(contacts in any of the campaign's lists) ∪ ∪(contacts
   * matching any of the campaign's segments). Filtered to subscribed only
   * — bounced/unsubscribed/complained recipients are excluded from sends.
   */
  private async resolveAudience(
    accountId: string,
    listIds: string[],
    segmentIds: string[],
  ): Promise<Array<{ id: string; email: string }>> {
    const byId = new Map<string, { id: string; email: string }>();

    if (listIds.length > 0) {
      const fromLists = await this.prisma.contact.findMany({
        where: {
          accountId,
          subscriptionStatus: 'subscribed',
          memberships: { some: { listId: { in: listIds } } },
        },
        select: { id: true, email: true },
      });
      for (const c of fromLists) byId.set(c.id, c);
    }

    if (segmentIds.length > 0) {
      const segs = await this.prisma.segment.findMany({
        where: { accountId, id: { in: segmentIds } },
        select: { definition: true },
      });
      for (const s of segs) {
        const ids = await this.segments.resolveContactIds(
          accountId,
          s.definition as never,
        );
        if (ids.size === 0) continue;
        // Pull subscribed contacts only — segments don't apply the
        // subscription filter implicitly, so we enforce it here at the
        // audience-merge boundary.
        const rows = await this.prisma.contact.findMany({
          where: {
            accountId,
            subscriptionStatus: 'subscribed',
            id: { in: [...ids] },
          },
          select: { id: true, email: true },
        });
        for (const c of rows) if (!byId.has(c.id)) byId.set(c.id, c);
      }
    }

    return [...byId.values()];
  }

  /**
   * Insert CampaignRecipient rows in chunks. `skipDuplicates` makes this
   * idempotent under retry (e.g. send() was called twice or the worker's
   * legacy materialiser also ran for a list-only campaign).
   */
  private async materialiseRecipients(
    campaignId: string,
    accountId: string,
    contacts: Array<{ id: string; email: string }>,
  ): Promise<void> {
    const BATCH = 5000;
    for (let i = 0; i < contacts.length; i += BATCH) {
      const slice = contacts.slice(i, i + BATCH);
      await this.prisma.campaignRecipient.createMany({
        data: slice.map((c) => ({
          accountId,
          campaignId,
          contactId: c.id,
          email: c.email,
          status: 'pending' as const,
        })),
        skipDuplicates: true,
      });
    }
  }

  async pause(accountId: string, id: string) {
    const swap = await this.prisma.campaign.updateMany({
      where: { id, accountId, status: { in: ['sending', 'scheduled'] } },
      data: { status: 'paused' },
    });
    if (swap.count === 0) {
      await this.assertExists(accountId, id);
      throw new ConflictException('当前活动状态不允许暂停');
    }
    return { ok: true };
  }

  async resume(accountId: string, id: string) {
    const swap = await this.prisma.campaign.updateMany({
      where: { id, accountId, status: 'paused' },
      data: { status: 'sending' },
    });
    if (swap.count === 0) {
      await this.assertExists(accountId, id);
      throw new ConflictException('当前活动未处于暂停状态');
    }
    await this.queue.add(
      QUEUE_NAMES.SEND_CAMPAIGN,
      'dispatch',
      { campaignId: id, accountId },
      { removeOnComplete: true },
    );
    return { ok: true };
  }

  async cancel(accountId: string, id: string) {
    const swap = await this.prisma.campaign.updateMany({
      where: {
        id,
        accountId,
        status: { in: ['sending', 'scheduled', 'paused'] },
      },
      data: { status: 'canceled' },
    });
    if (swap.count === 0) {
      await this.assertExists(accountId, id);
      throw new ConflictException('当前活动状态不允许取消');
    }
    // Eagerly mark all not-yet-sent recipients as skipped so the DB reflects
    // the cancellation immediately (instead of waiting for the worker to
    // drain the BullMQ backlog at the limiter rate). Worker still has the
    // c.status === 'canceled' guard as a defence-in-depth safety net for
    // the small race window during this UPDATE.
    await this.prisma.campaignRecipient.updateMany({
      where: {
        campaignId: id,
        accountId,
        status: { in: ['pending', 'queued'] },
      },
      data: { status: 'skipped' },
    });
    return { ok: true };
  }

  private async assertExists(accountId: string, id: string): Promise<void> {
    const exists = await this.prisma.campaign.findFirst({
      where: { id, accountId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException();
  }

  async remove(accountId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, accountId } });
    if (!c) throw new NotFoundException();
    if (c.status === 'sending') throw new ConflictException('正在发送的活动无法删除');
    await this.prisma.campaign.delete({ where: { id } });
  }

  async duplicate(accountId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({
      where: { id, accountId },
      include: { lists: true },
    });
    if (!c) throw new NotFoundException();
    return this.prisma.campaign.create({
      data: {
        accountId,
        name: `${c.name} (副本)`,
        subject: c.subject,
        preheader: c.preheader,
        fromName: c.fromName,
        fromEmail: c.fromEmail,
        replyTo: c.replyTo,
        templateId: c.templateId,
        editorMode: c.editorMode,
        mjml: c.mjml,
        html: c.html,
        thumbnail: c.thumbnail,
        designJson: c.designJson as Prisma.InputJsonValue | undefined,
        status: 'draft',
        utmEnabled: c.utmEnabled,
        utmSource: c.utmSource,
        utmMedium: c.utmMedium,
        utmCampaign: c.utmCampaign,
        trackClicks: c.trackClicks,
        lists: { create: c.lists.map((l) => ({ listId: l.listId })) },
      },
    });
  }
}
