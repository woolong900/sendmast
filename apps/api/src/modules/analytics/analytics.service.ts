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
     * Accepted by ACS but no delivery report yet (neither delivered nor
     * bounced nor send-failed). Mostly deferred/in-transit mail or delivery
     * reports we haven't received. = sent − delivered − bounces − failed.
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
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService, private readonly ch: ClickHouseService) {}

  async campaign(accountId: string, campaignId: string): Promise<CampaignAnalyticsView> {
    const c = await this.prisma.campaign.findFirst({
      where: { id: campaignId, accountId },
      select: { id: true, totalRecipients: true },
    });
    if (!c) throw new NotFoundException('活动不存在');

    // "发送/总投放" = the full audience we attempted (totalRecipients). Used as
    // the denominator for delivery/open/bounce rates so the funnel stays
    // consistent: 送达 + 弹回 + 失败 are all subsets of it and can never exceed it.
    const sent = c.totalRecipients;

    // "发送失败" counts ONLY send-time failures (quota exhausted / ACS-rejected).
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
    // Recipients with ANY terminal delivery outcome (delivered OR bounced),
    // deduplicated. Used for `pending` so a recipient who soft-bounced then
    // delivered (or hard+soft bounced) is counted once, not subtracted twice.
    let terminalRecipients = 0;
    let chOk = false;

    try {
      // One row of recipient-level uniques via uniqExactIf — each metric counts
      // DISTINCT recipients in that state. `bounces` dedups hard+soft (a single
      // recipient with both is one bounce), and `terminal` dedups the union of
      // delivered+bounce for the pending math below.
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
        terminal: string;
      }>(
        `SELECT
           toString(uniqExactIf(recipient_id, event_type = 'open')) AS opens,
           toString(uniqExactIf(recipient_id, event_type = 'click')) AS clicks,
           toString(uniqExactIf(recipient_id, event_type = 'delivered')) AS delivered,
           toString(uniqExactIf(recipient_id, event_type = 'bounce')) AS bounces,
           toString(uniqExactIf(recipient_id, event_type = 'bounce' AND bounce_kind = 'hard')) AS bounces_hard,
           toString(uniqExactIf(recipient_id, event_type = 'complaint')) AS complaints,
           toString(uniqExactIf(recipient_id, event_type = 'unsubscribe')) AS unsubscribes,
           toString(uniqExactIf(recipient_id, event_type IN ('delivered', 'bounce'))) AS terminal
         FROM sendmast.email_events
         WHERE account_id = {acc:UUID} AND campaign_id = {cid:UUID}`,
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
        terminalRecipients = Number(r.terminal);
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
      terminalRecipients = sent;
    }

    const safe = (a: number, b: number) => (b > 0 ? a / b : 0);

    // Whatever's left after a terminal outcome (delivered/bounced) or send-time
    // failure is still in flight (or its delivery report hasn't reached us).
    // `terminalRecipients` is the deduped delivered∪bounce set, so overlapping
    // states aren't subtracted twice. Clamp at 0 for safety.
    const pending = Math.max(0, sent - terminalRecipients - failed);

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

    return { campaignId, totals, rates, funnel };
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
