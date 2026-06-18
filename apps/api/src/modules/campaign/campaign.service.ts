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
    updatedAt?: Date;
    contactId?: string;
  },
  contactName?: ContactNamePair | null,
  eventTime?: Date | string | null,
): RecipientView {
  // eventTime resolution priority:
  //   1. explicit param (used by event-sourced tabs, e.g. opened/clicked/bounced)
  //   2. r.sentAt — set by worker-sender on successful ACS accept
  //   3. r.updatedAt — Prisma's @updatedAt; for status=failed rows worker-sender
  //      sets {status, errorMessage} which bumps updatedAt to "the time we
  //      decided this row was failed", which is exactly what the 失败时间 column
  //      should display
  // Falls through to null if none are present (e.g. archive table doesn't
  // store updatedAt — archived failed rows remain blank by design).
  const evt =
    eventTime instanceof Date
      ? eventTime.toISOString()
      : (eventTime ??
        (r.sentAt
          ? r.sentAt.toISOString()
          : r.updatedAt
            ? r.updatedAt.toISOString()
            : null));
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
  // `sent` is intentionally absent: 发送 means 总投放 (the whole audience), so
  // its list/count uses no status filter — see listRecipients().
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
          thumbnailPending: true,
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
      // 发送 = 总投放(totalRecipients),与活动详情口径一致;opened/clicked 来自 CH。
      stats: {
        ...(stats[r.id] ?? { sent: 0, opened: 0, clicked: 0 }),
        sent: r.totalRecipients,
      },
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

    // NB: `sent` (= 总投放) is filled by the caller from each campaign's
    // totalRecipients, not derived here — see list(). We only fetch CH engagement.
    // Unique opens / clicks from ClickHouse — one grouped query for all campaigns.
    // account_id is the leading sort key; filtering on it first lets CH skip
    // unrelated tenant data AND enforces tenant isolation defence-in-depth.
    // Best-effort; if CH is down we still return PG-derived sent counts.
    try {
      const rows = await this.ch.query<{
        cid: string;
        event_type: string;
        uniques: string;
      }>(
        // NB: alias must NOT be `campaign_id` — ClickHouse resolves aliases in
        // WHERE, so `... AS campaign_id` would shadow the UUID column with the
        // String alias and the `campaign_id IN ...` filter silently matches
        // nothing (no error). Use a distinct alias.
        `SELECT toString(campaign_id) AS cid,
                event_type,
                toString(uniqExact(recipient_id)) AS uniques
         FROM sendmast.email_events
         WHERE account_id = {acc:UUID}
           AND campaign_id IN {ids:Array(UUID)}
           AND event_type IN ('open','click')
         GROUP BY cid, event_type`,
        { acc: accountId, ids },
      );
      for (const r of rows) {
        const target = out[r.cid];
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
        senders: { orderBy: { position: 'asc' } },
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
      select: { id: true, account: { select: { isCollaborator: true } } },
    });
    if (!campaign) throw new NotFoundException('活动不存在');

    // sales 维度 = 归因到本活动的店铺订单 (ClickHouse sendmast.orders)。
    if (query.dimension === 'sales') {
      return this.listSalesRecipients(accountId, campaignId, query);
    }

    // 投递中 = 尚未交给 ACS 的待发送收件人 (status pending|queued)。纯 PG 查询。
    if (query.dimension === 'pending') {
      return this.listPendingRecipients(campaignId, query);
    }

    // Normal tenants get the softened view (collaborators see real data): soft
    // bounces are listed under 送达 instead of 弹回, and the 弹回 tab is empty
    // (its recipients moved to 送达). 无效邮箱 (hard) is unaffected.
    const softenBounce = !campaign.account?.isCollaborator;
    if (softenBounce && query.dimension === 'bounced') {
      return { source: 'events', rows: [], nextCursor: null, total: 0 };
    }
    if (softenBounce && query.dimension === 'delivered') {
      return this.listRecipientsFromEvents(accountId, campaignId, query, 'delivered', undefined, true);
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
    // PG dimensions:
    //   - `sent` = 总投放 → no status filter, list the whole audience so the
    //     count matches totalRecipients (送达/弹回/失败 are all subsets of it).
    //   - `failed` = 发送失败 → status='failed' but EXCLUDE bounce-induced rows
    //     (errorMessage='bounced'); those belong under 弹回, not 发送失败.
    const status =
      query.dimension === 'sent'
        ? undefined
        : (PG_STATUS_BY_DIMENSION[query.dimension] ?? query.status);
    const excludeBounced = query.dimension === 'failed';

    return archived
      ? this.listRecipientsFromArchive(
          accountId,
          campaignId,
          query,
          status,
          excludeBounced,
        )
      : this.listRecipientsFromHot(campaignId, query, status, excludeBounced);
  }

  private async listRecipientsFromHot(
    campaignId: string,
    q: ListRecipientsQuery,
    status: 'sent' | 'failed' | 'pending' | 'queued' | 'skipped' | undefined,
    excludeBounced = false,
  ): Promise<ListRecipientsResponse> {
    const where: Prisma.CampaignRecipientWhereInput = {
      campaignId,
      ...(status ? { status } : {}),
      // 退信被历史地记为 status='failed', errorMessage='bounced'。发送失败 tab
      // 要排除它们(归入弹回)。OR 兼容 errorMessage 为 null 的真实发送时失败。
      ...(excludeBounced
        ? { OR: [{ errorMessage: null }, { errorMessage: { not: 'bounced' } }] }
        : {}),
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
    excludeBounced = false,
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
    // `filter` is the full result-set predicate (no cursor) — used for the
    // total count. `where` adds the cursor for the page query only.
    let filter = 'account_id = {acc:UUID} AND campaign_id = {cid:UUID}';
    if (status) {
      filter += ' AND status = {status:String}';
      params.status = status;
    }
    if (excludeBounced) {
      // Genuine send-time failures may have NULL error_message; only exclude
      // the bounce-induced ones. (`x != 'bounced'` alone drops NULLs in CH,
      // which would hide real failures — mirror the hot PG path's OR-null.)
      filter += " AND (error_message IS NULL OR error_message != 'bounced')";
    }
    let where = filter;
    if (q.cursor) {
      where += ' AND id > {cursor:UUID}';
      params.cursor = q.cursor;
    }
    const [rows, totalRows] = await Promise.all([
      this.ch.query<{
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
      ),
      // Total over the full filter (sans cursor) so the footer "共 N 条" matches
      // the hot PG path, which also returns a total.
      this.ch.query<{ n: string }>(
        `SELECT toString(count()) AS n
         FROM sendmast.campaign_recipients_archive FINAL
         WHERE ${filter}`,
        params,
      ),
    ]);
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
      total: Number(totalRows[0]?.n ?? 0),
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
  /**
   * 投递中 list: 尚未交给 ACS 的待发送收件人 (status pending|queued)。纯 PG 查询 —
   * ACS 受理 (status='sent') 后即视为已投递，不再列入投递中。归档活动的热表行已被
   * 清走，自然返回空。
   */
  private async listPendingRecipients(
    campaignId: string,
    q: ListRecipientsQuery,
  ): Promise<ListRecipientsResponse> {
    const where: Prisma.CampaignRecipientWhereInput = {
      campaignId,
      status: { in: ['pending', 'queued'] },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.campaignRecipient.count({ where }),
      this.prisma.campaignRecipient.findMany({
        where,
        orderBy: { id: 'asc' },
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

  /**
   * sales list: store orders attributed to this campaign (last-click). Served
   * straight from ClickHouse `orders` (FINAL collapses re-ingest dupes). The
   * order value is surfaced via `reason` so the existing recipient table can
   * render it without a schema change; `eventTime` carries the order time.
   */
  private async listSalesRecipients(
    accountId: string,
    campaignId: string,
    q: ListRecipientsQuery,
  ): Promise<ListRecipientsResponse> {
    const params: Record<string, unknown> = {
      acc: accountId,
      cid: campaignId,
      lim: q.pageSize + 1,
    };
    let cursorClause = '';
    if (q.cursor) {
      cursorClause = 'AND order_time < parseDateTime64BestEffort({cursor:String}, 3)';
      params.cursor = q.cursor;
    }
    let rows: Array<{
      external_order_id: string;
      customer_email: string;
      value: string;
      currency: string;
      order_time: string;
    }> = [];
    let total: number | null = null;
    try {
      [rows, total] = await Promise.all([
        this.ch.query<{
          external_order_id: string;
          customer_email: string;
          value: string;
          currency: string;
          order_time: string;
        }>(
          `SELECT external_order_id, customer_email, toString(value) AS value,
                  currency, toString(order_time) AS order_time
           FROM sendmast.orders FINAL
           WHERE account_id = {acc:UUID} AND attributed_campaign_id = {cid:UUID}
           ${cursorClause}
           ORDER BY order_time DESC
           LIMIT {lim:UInt32}`,
          params,
        ),
        this.ch
          .query<{ n: string }>(
            `SELECT toString(count()) AS n
             FROM sendmast.orders FINAL
             WHERE account_id = {acc:UUID} AND attributed_campaign_id = {cid:UUID}`,
            { acc: accountId, cid: campaignId },
          )
          .then((r) => Number(r[0]?.n ?? 0)),
      ]);
    } catch (err) {
      // CH unavailable / table missing in dev → behave like an empty list.
      return { source: 'events', rows: [], nextCursor: null, total: 0 };
    }
    const hasMore = rows.length > q.pageSize;
    const page = hasMore ? rows.slice(0, q.pageSize) : rows;
    const orderIds = page.map((r) => r.external_order_id);
    const orders = orderIds.length
      ? await this.prisma.shopOrder.findMany({
          where: {
            accountId,
            attributedCampaignId: campaignId,
            externalOrderId: { in: orderIds },
          },
          select: {
            externalOrderId: true,
            orderNo: true,
            contactId: true,
            attributedContactId: true,
            customerEmail: true,
          },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.externalOrderId, o]));
    const contactIds = Array.from(
      new Set(
        orders
          .flatMap((o) => [o.contactId, o.attributedContactId])
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const contactEmails = Array.from(
      new Set(orders.map((o) => o.customerEmail.toLowerCase()).filter(Boolean)),
    );
    const contacts =
      contactIds.length || contactEmails.length
        ? await this.prisma.contact.findMany({
            where: {
              accountId,
              OR: [
                ...(contactIds.length ? [{ id: { in: contactIds } }] : []),
                ...(contactEmails.length ? [{ email: { in: contactEmails } }] : []),
              ],
            },
            select: { id: true, email: true, firstName: true, lastName: true },
          })
        : [];
    const contactById = new Map(contacts.map((c) => [c.id, c]));
    const contactByEmail = new Map(contacts.map((c) => [c.email.toLowerCase(), c]));
    return {
      source: 'events',
      rows: page.map((r) => {
        const order = orderById.get(r.external_order_id);
        const contact =
          (order?.contactId ? contactById.get(order.contactId) : undefined) ??
          (order?.attributedContactId ? contactById.get(order.attributedContactId) : undefined) ??
          contactByEmail.get((order?.customerEmail ?? r.customer_email).toLowerCase());
        return {
          id: r.external_order_id,
          email: r.customer_email,
          firstName: contact?.firstName ?? null,
          lastName: contact?.lastName ?? null,
          status: 'order',
          messageId: null,
          errorMessage: null,
          sentAt: r.order_time,
          createdAt: r.order_time,
          eventTime: r.order_time,
          userAgent: null,
          linkUrl: null,
          deliveredAt: null,
          reason: `${r.currency} ${r.value}`,
          bounceType: null,
          orderNo: order?.orderNo ?? r.external_order_id,
          orderAmount: Number(r.value),
          orderCurrency: r.currency,
        };
      }),
      nextCursor: hasMore ? page[page.length - 1].order_time : null,
      total,
    };
  }

  private async listRecipientsFromEvents(
    accountId: string,
    campaignId: string,
    q: ListRecipientsQuery,
    eventType: string,
    bounceKindFilter?: 'hard' | 'soft',
    // Softened 送达 view (normal tenants): match delivered events PLUS non-hard
    // (soft) bounces, so soft-bounced recipients show up under 送达. Hard
    // bounces stay out (they remain in the 无效邮箱 tab).
    foldSoftBounce = false,
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
    // The full event-match predicate, reused by both the page and the count
    // query below so they always agree.
    let eventClause: string;
    if (foldSoftBounce) {
      eventClause =
        "(event_type = 'delivered' OR (event_type = 'bounce' AND bounce_kind != 'hard'))";
    } else {
      eventClause = 'event_type = {et:String}';
      if (bounceKindFilter) {
        eventClause += ' AND bounce_kind = {bk:String}';
        params.bk = bounceKindFilter;
      }
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
      last_bounce_kind: string;
    }

    let rows: EventGroupRow[] = [];
    let total: number | null = null;
    try {
      // Rows (cursor-paginated) + grand total (unique recipients for this
      // event, ignoring the cursor) in one round-trip. The total mirrors the
      // analytics card's uniqExact count so the tab footer can show 共 N 条.
      const [rowsRes, countRes] = await Promise.all([
        this.ch.query<EventGroupRow>(
          `SELECT
             recipient_id,
             max(event_time) AS ts,
             argMax(user_agent, event_time) AS user_agent,
             argMax(link_url, event_time) AS link_url,
             argMax(raw_meta, event_time) AS raw_meta,
             -- Alias must NOT be bounce_kind: it would shadow the real column
             -- in the WHERE bounceClause below, and ClickHouse would resolve
             -- that filter to this aggregate (error: aggregate in WHERE).
             argMax(bounce_kind, event_time) AS last_bounce_kind
           FROM sendmast.email_events
           WHERE account_id = {acc:UUID}
             AND campaign_id = {cid:UUID}
             AND ${eventClause}
           GROUP BY recipient_id
           HAVING 1=1 ${cursorClause}
           ORDER BY ts DESC
           LIMIT {lim:UInt32}`,
          params,
        ),
        this.ch.query<{ total: string }>(
          `SELECT toString(uniqExact(recipient_id)) AS total
           FROM sendmast.email_events
           WHERE account_id = {acc:UUID}
             AND campaign_id = {cid:UUID}
             AND ${eventClause}`,
          params,
        ),
      ]);
      rows = rowsRes;
      total = Number(countRes[0]?.total ?? 0);
    } catch (err) {
      // ClickHouse unreachable → degrade to empty rather than 500. The UI
      // already shows the analytics card so users know events exist.
      console.warn('listRecipientsFromEvents: CH query failed', err);
      return { source: 'events', rows: [], nextCursor: null, total: null };
    }

    if (rows.length === 0) {
      return { source: 'events', rows: [], nextCursor: null, total };
    }

    const hasMore = rows.length > q.pageSize;
    const page = hasMore ? rows.slice(0, q.pageSize) : rows;
    const ids = page.map((r) => r.recipient_id);

    // Try PG first; missing ones (because the campaign was archived) come
    // from the cold archive table.
    const hot = await this.prisma.campaignRecipient.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, contactId: true, sentAt: true, status: true },
    });
    interface HotMeta {
      email: string;
      contactId: string | null;
      sentAt: Date | string | null;
      status: string;
    }
    const byId = new Map<string, HotMeta>(
      hot.map((r) => [
        r.id,
        { email: r.email, contactId: r.contactId, sentAt: r.sentAt, status: r.status },
      ]),
    );

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const cold = await this.ch.query<{
        id: string;
        email: string;
        sent_at: string | null;
        status: string;
      }>(
        `SELECT id, email, sent_at, status
         FROM sendmast.campaign_recipients_archive FINAL
         WHERE account_id = {acc:UUID}
           AND campaign_id = {cid:UUID}
           AND id IN {ids:Array(UUID)}`,
        { acc: accountId, cid: campaignId, ids: missing },
      );
      for (const c of cold) {
        // Archive table doesn't carry contact_id — name will fall back to null.
        byId.set(c.id, {
          email: c.email,
          contactId: null,
          sentAt: c.sent_at,
          status: c.status,
        });
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
             AND recipient_id IN {ids:Array(UUID)}
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
        r.last_bounce_kind === 'hard'
          ? '硬退'
          : r.last_bounce_kind === 'soft'
            ? '软退'
            : parsed.bounceType;
      return {
        id: r.recipient_id,
        email: meta?.email ?? '(unknown)',
        firstName: name?.firstName ?? null,
        lastName: name?.lastName ?? null,
        // Source the real send-pipeline status from the recipient row (PG hot
        // or archive cold) rather than a literal; for event-derived rows this
        // is virtually always 'sent' (an event presupposes a successful send),
        // but reading it keeps the field honest if that ever diverges.
        status: meta?.status ?? 'sent',
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
      total,
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
    const senders = this.senderRoster(input);

    const created = await this.prisma.campaign.create({
      data: {
        accountId,
        name: input.name,
        subject: input.subject,
        preheader: input.preheader,
        fromName: senders[0].fromName,
        fromEmail: senders[0].fromEmail,
        replyTo: input.replyTo,
        templateId: input.templateId,
        mjml,
        html,
        thumbnail: input.thumbnail,
        thumbnailPending: !!html,
        designJson: designJson as Prisma.InputJsonValue | undefined,
        editorMode: input.editorMode,
        status,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        utmEnabled: input.utmEnabled,
        utmSource: input.utmSource,
        utmMedium: input.utmMedium,
        utmCampaign: input.utmCampaign,
        trackClicks: input.trackClicks,
        lists: { create: input.listIds.map((listId, position) => ({ listId, position })) },
        segments: { create: input.segmentIds.map((segmentId) => ({ segmentId })) },
        senders: { create: senders },
      },
    });
    if (html) await this.enqueueThumbnail(created.id);
    return created;
  }

  /**
   * Normalise the campaign payload into an ordered, de-duplicated sender
   * roster. Position 0 is the primary (mirrored onto Campaign.fromEmail).
   * Falls back to the single { fromEmail, fromName } pair when no `senders`
   * array is supplied — keeps pre-feature clients working unchanged.
   */
  private senderRoster(input: {
    fromEmail: string;
    fromName: string;
    senders?: Array<{ fromEmail: string; fromName: string }>;
  }): Array<{ fromEmail: string; fromName: string; position: number }> {
    const raw =
      input.senders && input.senders.length > 0
        ? input.senders
        : [{ fromEmail: input.fromEmail, fromName: input.fromName }];
    const seen = new Set<string>();
    const out: Array<{ fromEmail: string; fromName: string; position: number }> = [];
    for (const s of raw) {
      const key = s.fromEmail.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ fromEmail: s.fromEmail.trim(), fromName: s.fromName.trim(), position: out.length });
    }
    return out;
  }

  /**
   * Queue a server-side thumbnail render (worker-thumbnail → headless Chromium).
   * Best-effort: a queue hiccup must not fail the campaign save, so we swallow
   * errors — the next save (or a manual retry) re-enqueues.
   */
  private async enqueueThumbnail(campaignId: string): Promise<void> {
    try {
      await this.queue.add(QueueService.names.RENDER_THUMBNAIL, 'render', {
        campaignId,
      });
    } catch (err) {
      console.warn('enqueueThumbnail failed', campaignId, err);
    }
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

    // Recompute the sender roster only when the caller touched sender fields.
    // A metadata-only PATCH (e.g. renaming the campaign) leaves senders alone.
    const touchedSenders =
      input.senders !== undefined ||
      input.fromEmail !== undefined ||
      input.fromName !== undefined;
    const senders = touchedSenders
      ? this.senderRoster({
          fromEmail: input.fromEmail ?? c.fromEmail,
          fromName: input.fromName ?? c.fromName,
          senders: input.senders,
        })
      : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.listIds) {
        await tx.campaignList.deleteMany({ where: { campaignId: id } });
        await tx.campaignList.createMany({
          data: input.listIds.map((listId, position) => ({ campaignId: id, listId, position })),
        });
      }
      if (input.segmentIds) {
        await tx.campaignSegment.deleteMany({ where: { campaignId: id } });
        await tx.campaignSegment.createMany({
          data: input.segmentIds.map((segmentId) => ({ campaignId: id, segmentId })),
        });
      }
      if (senders) {
        await tx.campaignSender.deleteMany({ where: { campaignId: id } });
        await tx.campaignSender.createMany({
          data: senders.map((s) => ({ campaignId: id, ...s })),
        });
      }

      return tx.campaign.update({
        where: { id },
        data: {
          name: input.name,
          subject: input.subject,
          preheader: input.preheader,
          fromName: senders ? senders[0].fromName : undefined,
          fromEmail: senders ? senders[0].fromEmail : undefined,
          replyTo: input.replyTo,
          templateId: input.templateId,
          mjml,
          html,
          thumbnail: input.thumbnail,
          // HTML changed → mark stale so the list shows a placeholder until the
          // worker re-renders. `undefined` leaves the flag untouched on
          // metadata-only edits.
          thumbnailPending: html != null ? true : undefined,
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
          senders: { orderBy: { position: 'asc' } },
        },
      });
    });
    if (html != null) await this.enqueueThumbnail(id);
    return updated;
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
      include: {
        lists: { orderBy: { position: 'asc' } },
        segments: true,
        senders: { orderBy: { position: 'asc' } },
      },
    });
    if (!c) throw new NotFoundException();
    if (!c.html) throw new BadRequestException('活动尚未设置邮件正文');

    // Resolve the campaign's full sender roster (falls back to the primary for
    // pre-feature campaigns with no campaign_senders rows) and validate every
    // address: its domain must be verified under an ACTIVE ACS account.
    // Senders MAY span multiple ACS accounts — each recipient is routed to its
    // own sender's ACS account at materialisation / dispatch time.
    const senders =
      c.senders.length > 0
        ? c.senders.map((s) => ({ fromEmail: s.fromEmail, fromName: s.fromName }))
        : [{ fromEmail: c.fromEmail, fromName: c.fromName }];

    const domainAcs = new Map<string, string>();
    const enrichedSenders: Array<{
      fromEmail: string;
      fromName: string;
      acsAccountId: string;
    }> = [];
    for (const s of senders) {
      const domain = s.fromEmail.split('@')[1];
      let acsId = domainAcs.get(domain);
      if (!acsId) {
        const verified = await this.prisma.senderDomain.findFirst({
          where: { accountId, domain, status: 'verified' },
          include: { acsAccount: true },
        });
        if (!verified) {
          throw new BadRequestException(`寄件域名 ${domain} 尚未验证`);
        }
        if (!verified.acsAccount) {
          throw new BadRequestException(`寄件域名 ${domain} 未分配 ACS 账号`);
        }
        if (verified.acsAccount.status !== 'active') {
          throw new BadRequestException(
            `ACS 账号 ${verified.acsAccount.name} 当前状态为 ${verified.acsAccount.status}`,
          );
        }
        acsId = verified.acsAccount.id;
        domainAcs.set(domain, acsId);
      }
      enrichedSenders.push({ ...s, acsAccountId: acsId });
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
      //
      // Materialise recipients BEFORE flipping status. Previously the status
      // was set to `sending` first and materialisation ran after — a failure
      // (or crash) in between left the campaign stranded in `sending` with
      // partial/zero recipients. Inserting first means any failure here throws
      // with the campaign still in its prior (non-sending) state; createMany's
      // skipDuplicates keeps a retry idempotent. The status CAS below is the
      // single point that actually commits the send.
      const inserted = await this.materialiseSegmentAudience(
        c.id,
        accountId,
        c.lists.map((l) => l.listId),
        c.segments.map((s) => s.segmentId),
        enrichedSenders,
      );
      if (inserted === 0) {
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
          totalRecipients: inserted,
          sendingStartedAt: isFuture ? null : new Date(),
        },
      });
      if (swap.count === 0) throw new ConflictException('当前活动状态不允许发送');
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
   * Stream a segment-enabled campaign's audience into campaign_recipients in
   * bounded batches. Audience = ∪(subscribed contacts in any list) ∪
   * ∪(subscribed contacts matching any segment).
   *
   * Memory and PG bind-params are both bounded: lists are streamed by id
   * cursor (same as the worker's list-only path) and each segment is resolved
   * to an id set then chunk-fetched — every `id IN (…)` query is ≤ BATCH, so
   * we never approach PG's 65535 param limit and never hold the full audience
   * in memory. A 342k-contact list used to blow up here on both counts.
   *
   * `skipDuplicates` deduplicates contacts shared across lists/segments and
   * keeps the whole thing idempotent under retry. Returns the number of
   * recipient rows actually inserted (= the subscribed audience size), which
   * the caller persists as `totalRecipients` and uses for the empty check.
   *
   * Note: segment evaluation stays in the API (the dispatch worker is
   * list-only by design and doesn't compile SegmentDefinition); only the
   * materialisation is streamed.
   */
  private async materialiseSegmentAudience(
    campaignId: string,
    accountId: string,
    listIds: string[],
    segmentIds: string[],
    senders: Array<{ fromEmail: string; fromName: string; acsAccountId: string }>,
  ): Promise<number> {
    // Single-sender campaigns leave the per-recipient from-columns NULL so the
    // worker falls back to Campaign.fromEmail/fromName — but we always stamp
    // acsAccountId so the dispatcher can route without re-resolving the domain.
    const rotate = senders.length > 1;
    const primaryAcs = senders[0]?.acsAccountId ?? null;
    const BATCH = 5000;
    let inserted = 0;
    // Rotation is positioned over rows *processed* (not just inserted) so the
    // round-robin stays even across batches even when skipDuplicates drops a
    // few — mirrors the worker's `(inserted + j)` convention.
    let positioned = 0;

    const insertBatch = async (
      rows: Array<{ id: string; email: string; listName?: string | null }>,
    ) => {
      if (rows.length === 0) return;
      const res = await this.prisma.campaignRecipient.createMany({
        data: rows.map((c, j) => {
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
            acsAccountId: s?.acsAccountId ?? primaryAcs,
          };
        }),
        skipDuplicates: true,
      });
      positioned += rows.length;
      inserted += res.count;
    };

    // 1. Lists — cursor-stream subscribed contacts so memory stays at one
    //    batch regardless of list size. Capture each contact's target list name
    //    for {{list_name}} — when a contact is in several target lists we take
    //    the FIRST one (by selection order; listIds is ordered by
    //    CampaignList.position). Frozen at materialisation, no send-time join.
    if (listIds.length > 0) {
      const listNameById = new Map(
        (
          await this.prisma.contactList.findMany({
            where: { id: { in: listIds } },
            select: { id: true, name: true },
          })
        ).map((l) => [l.id, l.name]),
      );
      let cursor: string | undefined;
      for (;;) {
        const rows = await this.prisma.contact.findMany({
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
              listName: firstListId ? listNameById.get(firstListId) ?? null : null,
            };
          }),
        );
        if (rows.length < BATCH) break;
        cursor = rows[rows.length - 1].id;
      }
    }

    // 2. Segments — resolve each to an id set, then chunk-fetch subscribed
    //    contacts (segments don't apply the subscription filter implicitly).
    //    skipDuplicates dedupes against lists / other segments.
    for (const segmentId of segmentIds) {
      const seg = await this.prisma.segment.findFirst({
        where: { accountId, id: segmentId },
        select: { definition: true },
      });
      if (!seg) continue;
      const ids = await this.segments.resolveContactIds(
        accountId,
        seg.definition as never,
      );
      if (ids.size === 0) continue;
      const arr = [...ids];
      for (let i = 0; i < arr.length; i += BATCH) {
        const rows = await this.prisma.contact.findMany({
          where: {
            accountId,
            subscriptionStatus: 'subscribed',
            id: { in: arr.slice(i, i + BATCH) },
          },
          select: { id: true, email: true },
        });
        await insertBatch(rows);
      }
    }

    return inserted;
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
      include: { lists: { orderBy: { position: 'asc' } }, senders: { orderBy: { position: 'asc' } } },
    });
    if (!c) throw new NotFoundException();
    const copy = await this.prisma.campaign.create({
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
        // Carry the source thumbnail (identical content) as a placeholder, but
        // mark pending so the worker renders the copy its own fresh image.
        thumbnail: c.thumbnail,
        thumbnailPending: !!c.html,
        designJson: c.designJson as Prisma.InputJsonValue | undefined,
        status: 'draft',
        utmEnabled: c.utmEnabled,
        utmSource: c.utmSource,
        utmMedium: c.utmMedium,
        utmCampaign: c.utmCampaign,
        trackClicks: c.trackClicks,
        lists: { create: c.lists.map((l, position) => ({ listId: l.listId, position })) },
        senders: {
          create: c.senders.map((s) => ({
            fromEmail: s.fromEmail,
            fromName: s.fromName,
            position: s.position,
          })),
        },
      },
    });
    if (c.html) await this.enqueueThumbnail(copy.id);
    return copy;
  }
}
