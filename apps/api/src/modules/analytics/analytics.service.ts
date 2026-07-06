import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClickHouseService } from '../../common/clickhouse/clickhouse.service';

export interface CampaignAnalyticsView {
  campaignId: string;
  totals: {
    recipients: number;
    sent: number;
    delivered: number;
    failed: number;
    /**
     * Backlog still waiting to be handed to the email channel — recipients in
     * status pending|queued. Once provider accepts (status='sent') a recipient is
     * considered delivered and drops out of this bucket, so a finished
     * campaign reads 0 here instead of getting stuck on missing delivery
     * reports.
     */
    pending: number;
    uniqueOpens: number;
    uniqueClicks: number;
    /** All bounces (hard + soft). */
    bounces: number;
    /** Hard bounces only — drives the "无效邮箱" card. */
    bouncesHard: number;
    complaints: number;
    unsubscribes: number;
  };
  rates: {
    delivery: number;
    uniqueOpen: number;
    uniqueClick: number;
    /** All bounces / sent. */
    bounce: number;
    /** Hard bounces / sent — drives the "无效邮箱率" card. */
    bounceHard: number;
    /** Pending / sent — drives the "投递中" card. */
    pending: number;
    complaint: number;
    unsubscribe: number;
  };
  funnel: Array<{ step: string; value: number; pct: number }>;
  /** Store revenue attributed to this campaign (last-click). Zeros when no
   *  shop is connected or ClickHouse is unavailable. */
  sales: { orders: number; revenue: number; currency: string; aov: number };
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ch: ClickHouseService,
  ) {}

  async campaign(accountId: string, campaignId: string): Promise<CampaignAnalyticsView> {
    const c = await this.prisma.campaign.findFirst({
      where: { id: campaignId, accountId },
      select: {
        id: true,
        totalRecipients: true,
        account: { select: { isCollaborator: true } },
      },
    });
    if (!c) throw new NotFoundException('活动不存在');

    // Normal tenants get a softened view: soft bounces (mostly reputation /
    // greylisting — recoverable) are folded into 送达 and 弹回邮箱率 is hidden.
    // Genuine 无效邮箱 (hard bounces) are left untouched. Collaborators (trusted
    // partners) see the real, unmodified deliverability data.
    const softenBounce = !c.account?.isCollaborator;

    // "发送/总投放" = the full audience we attempted (totalRecipients). Used as
    // the denominator for delivery/open/bounce rates so the funnel stays
    // consistent: 送达 + 弹回 + 失败 are all subsets of it and can never exceed it.
    const sent = c.totalRecipients;

    // "发送失败" counts ONLY send-time failures (quota exhausted / provider-rejected).
    // Hard bounces were historically stored as `status='failed',
    // errorMessage='bounced'` but belong under 弹回 — exclude them here so they
    // are not double-counted against 总投放.
    // Once a campaign is archived its hot PG rows are purged, so the PG count
    // would read 0 — count from the cold archive (ClickHouse) instead, mirroring
    // the same "exclude bounce-induced failures" rule.
    const archived = await this.prisma.campaignArchiveState.findUnique({
      where: { campaignId },
      select: { campaignId: true },
    });
    const failed = archived
      ? await this.countArchivedFailed(accountId, campaignId)
      : await this.prisma.campaignRecipient.count({
          where: {
            campaignId,
            status: 'failed',
            OR: [{ errorMessage: null }, { errorMessage: { not: 'bounced' } }],
          },
        });

    // Unique events from ClickHouse. We split bounces by `bounce_kind` so the
    // UI can show 无效邮箱率 (hard only) separate from 弹回邮箱率 (all).
    let uniqueOpens = 0;
    let uniqueClicks = 0;
    let delivered = 0;
    let bounces = 0;
    let bouncesHard = 0;
    let complaints = 0;
    let unsubscribes = 0;
    let chOk = false;

    try {
      // One row of recipient-level terminal outcomes. A provider can emit
      // `delivered` and later emit `bounce` for the same recipient (common with
      // delayed DSNs from mailbox providers such as Gmail). In that case bounce
      // wins: we must not count the same recipient as both delivered and
      // bounced, otherwise hard bounces can be hidden behind a 100% delivery
      // headline.
      // account_id is the leading sort key on email_events; filtering by it
      // first lets CH prune partitions/granules before scanning, AND keeps
      // tenant data strictly isolated as a defence-in-depth.
      const rows = await this.ch.query<{
        opens: string;
        clicks: string;
        delivered: string;
        bounces: string;
        bounces_hard: string;
        complaints: string;
        unsubscribes: string;
      }>(
        `SELECT
           toString(countIf(has_open)) AS opens,
           toString(countIf(has_click)) AS clicks,
           toString(countIf(has_delivered AND NOT has_bounce)) AS delivered,
           toString(countIf(has_bounce)) AS bounces,
           toString(countIf(has_hard_bounce)) AS bounces_hard,
           toString(countIf(has_complaint)) AS complaints,
           toString(countIf(has_unsubscribe)) AS unsubscribes
         FROM (
           SELECT
             recipient_id,
             max(event_type = 'open') AS has_open,
             max(event_type = 'click') AS has_click,
             max(event_type = 'delivered') AS has_delivered,
             max(event_type = 'bounce') AS has_bounce,
             max(event_type = 'bounce' AND bounce_kind = 'hard') AS has_hard_bounce,
             max(event_type = 'complaint') AS has_complaint,
             max(event_type = 'unsubscribe') AS has_unsubscribe
           FROM sendmast.email_events
           WHERE account_id = {acc:UUID} AND campaign_id = {cid:UUID}
           GROUP BY recipient_id
         )`,
        { acc: accountId, cid: campaignId },
      );
      const r = rows[0];
      if (r) {
        uniqueOpens = Number(r.opens);
        uniqueClicks = Number(r.clicks);
        delivered = Number(r.delivered);
        bounces = Number(r.bounces);
        bouncesHard = Number(r.bounces_hard);
        complaints = Number(r.complaints);
        unsubscribes = Number(r.unsubscribes);
      }
      chOk = true;
    } catch (err) {
      // ClickHouse unavailable -> degrade gracefully
      console.warn('ClickHouse aggregation failed:', err);
    }

    // Dev (mailhog) gets no delivery webhooks, so CH never records `delivered`.
    // Only then do we treat sent as delivered. We must NOT do this in prod or on
    // a CH outage (chOk === false) — that would fake 100% delivery and also hide
    // in-flight mail right after a real send before reports arrive.
    if (chOk && delivered === 0 && sent > 0 && process.env.NODE_ENV !== 'production') {
      delivered = sent;
    }

    // Fold soft bounces into 送达 for normal tenants. `bounces` is the deduped
    // set of recipients with ANY bounce; `bouncesHard` is the hard subset. The
    // soft-only set = bounces − bouncesHard moves to delivered; `bounces` then
    // collapses to the hard count so 弹回邮箱率 (hidden anyway) and the shared
    // `outcome` denominator stay self-consistent (送达+弹回+失败 is unchanged).
    if (softenBounce) {
      const softBounces = Math.max(0, bounces - bouncesHard);
      delivered += softBounces;
      bounces = bouncesHard;
    }

    const safe = (a: number, b: number) => (b > 0 ? a / b : 0);

    // 投递中 = 尚未交给邮件通道 的待发送收件人 (status pending|queued)。邮件通道受理
    // (status='sent') 后即视为已投递，不再因缺投递回执而长期停留在投递中。归档
    // 活动的热表行已被清走且都已是终态，故计 0。
    const pending = archived
      ? 0
      : await this.prisma.campaignRecipient.count({
          where: { campaignId, status: { in: ['pending', 'queued'] } },
        });

    const totals = {
      recipients: c.totalRecipients,
      sent,
      delivered,
      failed,
      pending,
      uniqueOpens,
      uniqueClicks,
      bounces,
      bouncesHard,
      complaints,
      unsubscribes,
    };

    // Shared denominator for all engagement/deliverability rates: messages that
    // reached a final outcome (送达 + 弹回 + 失败), excluding still-pending mail
    // whose delivery reports are in flight. Keeps every rate on one consistent
    // base so they don't disagree. (投递中 is intentionally kept on /总投放.)
    const outcome = delivered + bounces + failed;
    const rates = {
      delivery: safe(delivered, outcome),
      uniqueOpen: safe(uniqueOpens, outcome),
      uniqueClick: safe(uniqueClicks, outcome),
      bounce: safe(bounces, outcome),
      bounceHard: safe(bouncesHard, outcome),
      pending: safe(pending, sent),
      complaint: safe(complaints, outcome),
      unsubscribe: safe(unsubscribes, outcome),
    };

    // Sales attributed to this campaign (last-click). Degrades to zeros if CH
    // is down or no shop is connected.
    let sales = { orders: 0, revenue: 0, currency: 'USD', aov: 0 };
    try {
      const sr = await this.ch.query<{ orders: string; revenue: string; currency: string }>(
        `SELECT toString(count()) AS orders,
                toString(toFloat64(sum(value))) AS revenue,
                any(currency) AS currency
         FROM sendmast.orders FINAL
         WHERE account_id = {acc:UUID} AND attributed_campaign_id = {cid:UUID}`,
        { acc: accountId, cid: campaignId },
      );
      const r = sr[0];
      if (r) {
        const orders = Number(r.orders);
        const revenue = Number(r.revenue);
        sales = {
          orders,
          revenue,
          currency: r.currency || 'USD',
          aov: orders > 0 ? revenue / orders : 0,
        };
      }
    } catch (err) {
      console.warn('ClickHouse sales aggregation failed:', err);
    }

    const sentBase = sent || c.totalRecipients;
    const funnel = [
      { step: 'sent', value: sent, pct: sentBase > 0 ? 1 : 0 },
      // Each step reuses the matching headline card's rate so the funnel and
      // the cards never disagree: 送达 = 送达/(送达+弹回+失败); 打开/点击 =
      // 打开(点击)人数/送达数.
      { step: 'delivered', value: delivered, pct: rates.delivery },
      { step: 'opened', value: uniqueOpens, pct: rates.uniqueOpen },
      { step: 'clicked', value: uniqueClicks, pct: rates.uniqueClick },
    ];

    return { campaignId, totals, rates, funnel, sales };
  }

  /**
   * Count send-time failures for an archived campaign from the cold archive in
   * ClickHouse. Mirrors the hot-path rule: status='failed' EXCLUDING rows that
   * are really hard bounces (error_message='bounced'). NULL error_message is
   * kept (genuine send-time failures). FINAL merges any unmerged archive parts.
   * Degrades to 0 if ClickHouse is unavailable.
   */
  private async countArchivedFailed(accountId: string, campaignId: string): Promise<number> {
    try {
      const rows = await this.ch.query<{ n: string }>(
        `SELECT toString(count()) AS n
         FROM sendmast.campaign_recipients_archive FINAL
         WHERE account_id = {acc:UUID} AND campaign_id = {cid:UUID}
           AND status = 'failed'
           AND (error_message IS NULL OR error_message != 'bounced')`,
        { acc: accountId, cid: campaignId },
      );
      return Number(rows[0]?.n ?? 0);
    } catch (err) {
      console.warn('ClickHouse archived-failed count failed:', err);
      return 0;
    }
  }
}
