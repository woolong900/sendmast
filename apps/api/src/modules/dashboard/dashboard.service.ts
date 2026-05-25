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

    const [contactsTotal, contactsSubscribed, campaignGroups, sent30d, uniqueOpens30d] =
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
        // Authoritative "封数发出" count — sent state is the source of truth
        // in PG (CH only sees `delivered`, which won't fire in mailhog dev).
        this.prisma.campaignRecipient.count({
          where: { accountId, status: 'sent', sentAt: { gte: since } },
        }),
        this.queryUniqueOpens30d(accountId, since),
      ]);

    const campaigns = { draft: 0, scheduled: 0, sending: 0, sent: 0 };
    for (const g of campaignGroups) {
      if (g.status in campaigns) {
        (campaigns as Record<string, number>)[g.status] = g._count._all;
      }
    }

    const openRate30d = sent30d > 0 ? uniqueOpens30d / sent30d : 0;

    return {
      contacts: { total: contactsTotal, subscribed: contactsSubscribed },
      campaigns,
      metrics30d: { sent: sent30d, uniqueOpens: uniqueOpens30d, openRate: openRate30d },
      shopConnected: false, // v0.5
      sales: { revenue: 0, orders: 0, aov: 0 },
    };
  }

  /**
   * Unique opens (distinct recipient_id with an `open` event) in the last
   * 30 days for this tenant. Returns 0 on CH outage so the dashboard still
   * renders — cards will just show 0% open rate, which is honest.
   */
  private async queryUniqueOpens30d(accountId: string, since: Date): Promise<number> {
    try {
      // CH typed DateTime64 params don't accept the trailing `Z` from
      // Date#toISOString (parser expects `YYYY-MM-DDTHH:MM:SS.sss` and
      // chokes at byte 24). Pass as String and let parseDateTime64BestEffort
      // do the lenient parse — same pattern used in campaign.service.ts.
      const rows = await this.ch.query<{ uniques: string }>(
        `SELECT toString(uniqExact(recipient_id)) AS uniques
         FROM sendmast.email_events
         WHERE account_id = {aid:UUID}
           AND event_type = 'open'
           AND event_time >= parseDateTime64BestEffort({ts:String}, 3)`,
        { aid: accountId, ts: since.toISOString() },
      );
      return Number(rows[0]?.uniques ?? 0);
    } catch (err) {
      console.warn('Dashboard 30d opens query failed:', err);
      return 0;
    }
  }
}
