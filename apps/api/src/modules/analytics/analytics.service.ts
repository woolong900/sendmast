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
    const failed = await this.prisma.campaignRecipient.count({
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

    try {
      // Group by (event_type, bounce_kind) so a single round-trip yields
      // both totals — for non-bounce rows bounce_kind defaults to '' and we
      // ignore the second key.
      // account_id is the leading sort key on email_events; filtering by it
      // first lets CH prune partitions/granules before scanning, AND keeps
      // tenant data strictly isolated as a defence-in-depth.
      const rows = await this.ch.query<{
        event_type: string;
        bounce_kind: string;
        uniques: string;
      }>(
        `SELECT event_type, bounce_kind, toString(uniqExact(recipient_id)) AS uniques
         FROM sendmast.email_events
         WHERE account_id = {acc:UUID} AND campaign_id = {cid:UUID}
         GROUP BY event_type, bounce_kind`,
        { acc: accountId, cid: campaignId },
      );
      for (const r of rows) {
        const n = Number(r.uniques);
        if (r.event_type === 'open') uniqueOpens += n;
        else if (r.event_type === 'click') uniqueClicks += n;
        else if (r.event_type === 'delivered') delivered += n;
        else if (r.event_type === 'bounce') {
          bounces += n;
          if (r.bounce_kind === 'hard') bouncesHard += n;
        } else if (r.event_type === 'complaint') complaints += n;
        else if (r.event_type === 'unsubscribe') unsubscribes += n;
      }
    } catch (err) {
      // ClickHouse unavailable -> degrade gracefully
      console.warn('ClickHouse aggregation failed:', err);
    }

    // For mailhog dev mode we won't get delivery webhooks; treat sent as delivered.
    if (delivered === 0 && sent > 0) delivered = sent;

    const safe = (a: number, b: number) => (b > 0 ? a / b : 0);

    // Whatever's left after delivered/bounced/failed is still in flight (or its
    // delivery report hasn't reached us). Clamp at 0 — delivered & bounces are
    // independent uniqExact counts from CH so a soft-bounce-then-delivered
    // recipient could otherwise push this slightly negative.
    const pending = Math.max(0, sent - delivered - bounces - failed);

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

    const rates = {
      // 送达率 denominator excludes still-pending mail: of the messages that
      // reached a final outcome (delivered + bounced + failed), how many
      // delivered. Pending recipients don't drag the rate down while their
      // delivery reports are still in flight.
      delivery: safe(delivered, delivered + bounces + failed),
      uniqueOpen: safe(uniqueOpens, delivered || sent),
      uniqueClick: safe(uniqueClicks, delivered || sent),
      bounce: safe(bounces, sent),
      bounceHard: safe(bouncesHard, sent),
      pending: safe(pending, sent),
      complaint: safe(complaints, sent),
      unsubscribe: safe(unsubscribes, sent),
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
}
