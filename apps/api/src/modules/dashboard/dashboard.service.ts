import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClickHouseService } from '../../common/clickhouse/clickhouse.service';

export interface DashboardSummary {
  contacts: { total: number; subscribed: number };
  campaigns: { draft: number; scheduled: number; sending: number; sent: number };
  /** Rolling 30-day metrics — drives the top-row stat cards on the dashboard. */
  metrics30d: { sent: number; uniqueOpens: number; openRate: number };
  shopConnected: boolean;
  sales: { revenue: number; orders: number; aov: number };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ch: ClickHouseService,
  ) {}

  async summary(accountId: string): Promise<DashboardSummary> {
    // Window is closed-open [since, now). 30 days is well inside the
    // archive window (90d default) so PG holds all the rows we need.
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);

    const [contactsTotal, contactsSubscribed, campaignGroups, sentCampaigns] =
      await Promise.all([
        this.prisma.contact.count({ where: { accountId } }),
        this.prisma.contact.count({
          where: { accountId, subscriptionStatus: 'subscribed' },
        }),
        this.prisma.campaign.groupBy({
          by: ['status'],
          where: { accountId },
          _count: { _all: true },
        }),
        // The cohort for the open-rate card: campaigns SENT in the window.
        // Anchoring both numerator and denominator to the same campaign set
        // keeps openRate ≤ 100% — previously opens were counted by open-time,
        // so an open of a campaign sent before the window inflated the rate
        // above 100% against an in-window send denominator.
        this.prisma.campaign.findMany({
          where: { accountId, sentAt: { gte: since } },
          select: { id: true },
        }),
      ]);

    const cohortIds = sentCampaigns.map((c) => c.id);
    const [sent30d, uniqueOpens30d] = await Promise.all([
      // Authoritative "封数发出" count — sent state is the source of truth in
      // PG (CH only sees `delivered`, which won't fire in mailhog dev). 30d is
      // inside the 90d archive window so rows are still in PG.
      cohortIds.length
        ? this.prisma.campaignRecipient.count({
            where: { accountId, status: 'sent', campaignId: { in: cohortIds } },
          })
        : Promise.resolve(0),
      cohortIds.length ? this.queryUniqueOpens30d(accountId, cohortIds) : Promise.resolve(0),
    ]);

    const campaigns = { draft: 0, scheduled: 0, sending: 0, sent: 0 };
    for (const g of campaignGroups) {
      if (g.status in campaigns) {
        (campaigns as Record<string, number>)[g.status] = g._count._all;
      }
    }

    const openRate30d = sent30d > 0 ? uniqueOpens30d / sent30d : 0;

    const [shopConnected, sales] = await Promise.all([
      this.prisma.shopConnection
        .count({ where: { accountId, status: 'active' } })
        .then((n) => n > 0),
      this.querySales30d(accountId, since),
    ]);

    return {
      contacts: { total: contactsTotal, subscribed: contactsSubscribed },
      campaigns,
      metrics30d: { sent: sent30d, uniqueOpens: uniqueOpens30d, openRate: openRate30d },
      shopConnected,
      sales,
    };
  }

  /**
   * Email-attributed sales over the last 30 days — orders attributed to either
   * a campaign (last-click) OR a flow/automation (hard sm_mid attribution).
   * Read from Postgres shop_orders, which is the source of truth for both
   * attribution kinds (ClickHouse orders carries campaign attribution only).
   * Returns zeros on error so the dashboard still renders.
   */
  private async querySales30d(
    accountId: string,
    since: Date,
  ): Promise<{ revenue: number; orders: number; aov: number }> {
    try {
      const agg = await this.prisma.shopOrder.aggregate({
        where: {
          accountId,
          orderTime: { gte: since },
          OR: [{ attributedCampaignId: { not: null } }, { attributedAutomationId: { not: null } }],
        },
        _count: { _all: true },
        _sum: { value: true },
      });
      const orders = agg._count._all;
      const revenue = Number(agg._sum.value ?? 0);
      return { orders, revenue, aov: orders > 0 ? revenue / orders : 0 };
    } catch (err) {
      console.warn('Dashboard 30d sales query failed:', err);
      return { revenue: 0, orders: 0, aov: 0 };
    }
  }

  /**
   * Unique openers (distinct recipient_id with an `open` event) across the
   * given campaign cohort for this tenant. Returns 0 on CH outage so the
   * dashboard still renders — cards will just show 0% open rate, which is
   * honest. Anchored to campaign_id (not open-time) so the count aligns with
   * the same campaigns used in the send denominator.
   */
  private async queryUniqueOpens30d(accountId: string, campaignIds: string[]): Promise<number> {
    try {
      const rows = await this.ch.query<{ uniques: string }>(
        `SELECT toString(uniqExact(recipient_id)) AS uniques
         FROM sendmast.email_events
         WHERE account_id = {aid:UUID}
           AND event_type = 'open'
           AND campaign_id IN ({cids:Array(UUID)})`,
        { aid: accountId, cids: campaignIds },
      );
      return Number(rows[0]?.uniques ?? 0);
    } catch (err) {
      console.warn('Dashboard 30d opens query failed:', err);
      return 0;
    }
  }
}
