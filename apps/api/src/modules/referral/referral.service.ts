import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  CommissionMonthlySummary,
  CommissionRecordView,
  ReferralChannelInput,
  ReferralChannelView,
  ReferralLookupView,
  ReferralSettingView,
} from '@sendmast/shared';

/** Cheap stringify of a Prisma Decimal (or anything with toString). The
 *  Prisma client returns Decimal instances at runtime; we ship JSON, so
 *  we Number(...) them at the API boundary. Round-trip safe for our
 *  Decimal(10,2) / Decimal(5,2) columns (max 8 significant digits, way
 *  inside the 15-digit safe range of IEEE-754 double). */
function decimalToNumber(v: Prisma.Decimal | number): number {
  return typeof v === 'number' ? v : Number(v.toString());
}

/** Tx client type so this service can both run standalone AND be called
 *  from inside QuotaBillingService.$transaction(...) without spawning a
 *  nested transaction. */
type Tx = PrismaService | Prisma.TransactionClient;

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Channel CRUD (admin)
  // -------------------------------------------------------------------------

  async listChannels(): Promise<ReferralChannelView[]> {
    // One query for the channel rows, one aggregate query for per-channel
    // stats. Keeping them split (vs. a Prisma _count + raw SQL sum) means
    // we don't have to drop to $queryRaw, which is a pain to keep typed.
    const rows = await this.prisma.referralChannel.findMany({
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { accounts: true } } },
    });
    if (rows.length === 0) return [];

    const totals = await this.prisma.commissionRecord.groupBy({
      by: ['channelId'],
      _sum: { commissionCny: true },
    });
    const totalsByChannel = new Map(
      totals.map((t) => [t.channelId, decimalToNumber(t._sum.commissionCny ?? 0)]),
    );

    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      contact: r.contact,
      payoutInfo: r.payoutInfo,
      notes: r.notes,
      active: r.active,
      referredAccountCount: r._count.accounts,
      totalCommissionCny: totalsByChannel.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async createChannel(input: ReferralChannelInput): Promise<ReferralChannelView> {
    const existing = await this.prisma.referralChannel.findUnique({
      where: { code: input.code },
    });
    if (existing) throw new BadRequestException(`推荐码 ${input.code} 已被占用`);

    const row = await this.prisma.referralChannel.create({
      data: {
        code: input.code,
        name: input.name,
        contact: input.contact ?? null,
        payoutInfo: input.payoutInfo ?? null,
        notes: input.notes ?? null,
        active: input.active,
      },
    });
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      contact: row.contact,
      payoutInfo: row.payoutInfo,
      notes: row.notes,
      active: row.active,
      referredAccountCount: 0,
      totalCommissionCny: 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async updateChannel(id: string, input: ReferralChannelInput): Promise<ReferralChannelView> {
    const current = await this.prisma.referralChannel.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('渠道不存在');
    if (input.code !== current.code) {
      const dupe = await this.prisma.referralChannel.findUnique({
        where: { code: input.code },
      });
      if (dupe) throw new BadRequestException(`推荐码 ${input.code} 已被占用`);
    }
    const row = await this.prisma.referralChannel.update({
      where: { id },
      data: {
        code: input.code,
        name: input.name,
        contact: input.contact ?? null,
        payoutInfo: input.payoutInfo ?? null,
        notes: input.notes ?? null,
        active: input.active,
      },
      include: { _count: { select: { accounts: true } } },
    });
    const totals = await this.prisma.commissionRecord.aggregate({
      where: { channelId: id },
      _sum: { commissionCny: true },
    });
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      contact: row.contact,
      payoutInfo: row.payoutInfo,
      notes: row.notes,
      active: row.active,
      referredAccountCount: row._count.accounts,
      totalCommissionCny: decimalToNumber(totals._sum.commissionCny ?? 0),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async deleteChannel(id: string): Promise<void> {
    // Refuse if any commission has accrued (CommissionRecord -> Restrict
    // would error anyway, but the message we throw here is clearer).
    const commissionCount = await this.prisma.commissionRecord.count({
      where: { channelId: id },
    });
    if (commissionCount > 0) {
      throw new BadRequestException(
        `该渠道已产生 ${commissionCount} 条返佣记录,无法删除。请改为禁用。`,
      );
    }
    try {
      await this.prisma.referralChannel.delete({ where: { id } });
    } catch {
      throw new NotFoundException('渠道不存在');
    }
  }

  // -------------------------------------------------------------------------
  // Public — lookup by code (used by signup landing page)
  // -------------------------------------------------------------------------

  async lookupByCode(rawCode: string): Promise<ReferralLookupView | null> {
    const code = rawCode.trim().toUpperCase();
    if (!code) return null;
    const row = await this.prisma.referralChannel.findUnique({ where: { code } });
    if (!row || !row.active) return null;
    return { code: row.code, name: row.name };
  }

  /** Resolve a possibly-stale code from a signup request. Returns the
   *  channel's id when the code matches an ACTIVE row, else null — never
   *  throws, so a bad/expired link can never block signup. */
  async resolveChannelIdForSignup(rawCode: string | undefined): Promise<string | null> {
    if (!rawCode) return null;
    const code = rawCode.trim().toUpperCase();
    if (!code) return null;
    const row = await this.prisma.referralChannel.findUnique({
      where: { code },
      select: { id: true, active: true },
    });
    if (!row || !row.active) {
      this.logger.log(`signup referral code ignored: ${code} (unknown / disabled)`);
      return null;
    }
    return row.id;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async getSettings(): Promise<ReferralSettingView> {
    // The 'singleton' row is seeded by the migration so this find always
    // hits. Fall back to a hard-coded 15% just to satisfy the type if
    // someone DELETEs it by hand — they'll see the default and the
    // updateSettings call will re-create the row.
    const row = await this.prisma.referralSetting.findUnique({
      where: { id: 'singleton' },
    });
    if (!row) return { ratePercent: 15, updatedAt: new Date(0).toISOString() };
    return {
      ratePercent: decimalToNumber(row.ratePercent),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async updateSettings(
    ratePercent: number,
    updatedBy: string | null,
  ): Promise<ReferralSettingView> {
    const row = await this.prisma.referralSetting.upsert({
      where: { id: 'singleton' },
      update: { ratePercent, updatedBy },
      create: { id: 'singleton', ratePercent, updatedBy },
    });
    return {
      ratePercent: decimalToNumber(row.ratePercent),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Commission generation (called from QuotaBillingService on paid order)
  // -------------------------------------------------------------------------

  /**
   * Idempotent: creates a CommissionRecord for the given order iff the
   * order's account has a `referredByChannelId` set AND no record already
   * exists for that order. The orderId UNIQUE constraint is the
   * belt-and-suspenders against retried Shouqianba notifies — the
   * pre-check just lets us skip the round-trip when there's nothing to do.
   *
   * Safe to call OUTSIDE a transaction (we own one short one); callers
   * MAY pass their tx client to fold this into a larger transaction.
   * Errors here are logged but NEVER thrown — failing to write a
   * commission row must not roll back the user's paid order.
   */
  async recordCommissionForPaidOrder(orderId: string, tx: Tx = this.prisma): Promise<void> {
    try {
      const order = await tx.quotaOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          accountId: true,
          amountCny: true,
          paidAt: true,
          account: { select: { referredByChannelId: true } },
        },
      });
      if (!order) {
        this.logger.warn(`commission skip: order ${orderId} not found`);
        return;
      }
      const channelId = order.account.referredByChannelId;
      if (!channelId) return; // not a referred account — nothing to do

      const existing = await tx.commissionRecord.findUnique({
        where: { orderId },
        select: { id: true },
      });
      if (existing) return; // already credited (notify replay)

      // Re-read the channel inside the txn to confirm it still exists +
      // active; if the admin disabled it between signup and this payment,
      // we honour the existing attribution (lifetime commission was the
      // chosen window). Disabled channels still earn commission on
      // pre-existing referrals; only NEW signups can't pick a disabled
      // channel. Adjust here if the policy ever changes.
      const channel = await tx.referralChannel.findUnique({
        where: { id: channelId },
        select: { id: true },
      });
      if (!channel) {
        this.logger.warn(`commission skip: order ${orderId} channel ${channelId} deleted`);
        return;
      }

      const settingsRow = await tx.referralSetting.findUnique({
        where: { id: 'singleton' },
        select: { ratePercent: true },
      });
      const ratePercent = settingsRow ? decimalToNumber(settingsRow.ratePercent) : 15;
      const orderAmountCny = decimalToNumber(order.amountCny);
      // Round to fen so the sum of monthly commissions is a clean Decimal
      // the operator can pay through a Chinese bank without rounding-up
      // arguments. JS-side because Decimal arithmetic in Prisma isn't
      // pleasant; Decimal(10,2) on the column enforces it server-side too.
      const commissionCny = Math.round(orderAmountCny * ratePercent) / 100;

      await tx.commissionRecord.create({
        data: {
          channelId,
          orderId,
          accountId: order.accountId,
          orderAmountCny,
          ratePercent,
          commissionCny,
          paidAt: order.paidAt ?? new Date(),
        },
      });
      this.logger.log(
        `commission recorded: order ${orderId} -> channel ${channelId}, ` +
          `¥${orderAmountCny} * ${ratePercent}% = ¥${commissionCny}`,
      );
    } catch (err) {
      // Silently swallow — see method doc. Log loudly so ops sees it.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`commission record failed for order ${orderId}: ${msg}`);
    }
  }

  // -------------------------------------------------------------------------
  // Commission read (admin)
  // -------------------------------------------------------------------------

  /** Resolve a YYYY-MM string to its UTC [start, end) range. We use UTC
   *  on purpose so the export covers a stable calendar slice regardless
   *  of the server's TZ (paid_at is stored as TIMESTAMP without TZ but
   *  inserted as a JS Date in UTC by Prisma). */
  private monthRange(month: string): { start: Date; end: Date } {
    const [y, m] = month.split('-').map((n) => Number(n));
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    return { start, end };
  }

  async listCommissions(args: {
    month: string;
    channelId?: string;
  }): Promise<CommissionRecordView[]> {
    const { start, end } = this.monthRange(args.month);
    const rows = await this.prisma.commissionRecord.findMany({
      where: {
        paidAt: { gte: start, lt: end },
        ...(args.channelId ? { channelId: args.channelId } : {}),
      },
      orderBy: { paidAt: 'desc' },
      include: {
        channel: { select: { code: true, name: true } },
        account: {
          select: {
            name: true,
            members: {
              where: { role: 'owner' },
              orderBy: { createdAt: 'asc' },
              take: 1,
              select: { user: { select: { email: true } } },
            },
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channelId,
      channelCode: r.channel.code,
      channelName: r.channel.name,
      accountId: r.accountId,
      accountName: r.account.name,
      accountOwnerEmail: r.account.members[0]?.user.email ?? null,
      orderId: r.orderId,
      orderAmountCny: decimalToNumber(r.orderAmountCny),
      ratePercent: decimalToNumber(r.ratePercent),
      commissionCny: decimalToNumber(r.commissionCny),
      paidAt: r.paidAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async monthlySummary(month: string): Promise<CommissionMonthlySummary> {
    const { start, end } = this.monthRange(month);
    const grouped = await this.prisma.commissionRecord.groupBy({
      by: ['channelId'],
      where: { paidAt: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { orderAmountCny: true, commissionCny: true },
    });
    if (grouped.length === 0) {
      return {
        month,
        totalOrderCount: 0,
        totalOrderAmountCny: 0,
        totalCommissionCny: 0,
        rows: [],
      };
    }
    const channels = await this.prisma.referralChannel.findMany({
      where: { id: { in: grouped.map((g) => g.channelId) } },
      select: { id: true, code: true, name: true },
    });
    const chanById = new Map(channels.map((c) => [c.id, c]));

    let totalOrderCount = 0;
    let totalOrderAmountCny = 0;
    let totalCommissionCny = 0;
    const rows = grouped
      .map((g) => {
        const chan = chanById.get(g.channelId);
        const orderAmountCny = decimalToNumber(g._sum.orderAmountCny ?? 0);
        const commissionCny = decimalToNumber(g._sum.commissionCny ?? 0);
        totalOrderCount += g._count._all;
        totalOrderAmountCny += orderAmountCny;
        totalCommissionCny += commissionCny;
        return {
          channelId: g.channelId,
          channelCode: chan?.code ?? '(已删除)',
          channelName: chan?.name ?? '(已删除)',
          orderCount: g._count._all,
          orderAmountCny,
          commissionCny,
        };
      })
      .sort((a, b) => b.commissionCny - a.commissionCny);

    return {
      month,
      totalOrderCount,
      totalOrderAmountCny: Math.round(totalOrderAmountCny * 100) / 100,
      totalCommissionCny: Math.round(totalCommissionCny * 100) / 100,
      rows,
    };
  }

  /** Build the CSV body for a per-month export. UTF-8 BOM prefix so Excel
   *  on Windows opens it without garbling Chinese; standard RFC 4180
   *  quoting for fields. Two sections separated by a blank line: a per-
   *  channel summary table followed by the per-order detail table. */
  async exportCommissionsCsv(args: { month: string; channelId?: string }): Promise<string> {
    const summary = await this.monthlySummary(args.month);
    const detail = await this.listCommissions(args);

    const lines: string[] = [];
    lines.push(`返佣月份: ${args.month}`);
    lines.push(
      `总订单数: ${summary.totalOrderCount}, 总订单金额: ¥${summary.totalOrderAmountCny.toFixed(2)}, 总返佣: ¥${summary.totalCommissionCny.toFixed(2)}`,
    );
    lines.push('');
    lines.push('== 渠道汇总 ==');
    lines.push(
      ['渠道编码', '渠道名称', '订单数', '订单金额(CNY)', '返佣金额(CNY)'].map(csvField).join(','),
    );
    for (const r of summary.rows) {
      if (args.channelId && r.channelId !== args.channelId) continue;
      lines.push(
        [
          r.channelCode,
          r.channelName,
          r.orderCount,
          r.orderAmountCny.toFixed(2),
          r.commissionCny.toFixed(2),
        ]
          .map(csvField)
          .join(','),
      );
    }
    lines.push('');
    lines.push('== 订单明细 ==');
    lines.push(
      [
        '支付时间',
        '渠道编码',
        '渠道名称',
        '租户名称',
        '租户负责人邮箱',
        '订单ID',
        '订单金额(CNY)',
        '费率(%)',
        '返佣金额(CNY)',
      ]
        .map(csvField)
        .join(','),
    );
    for (const r of detail) {
      lines.push(
        [
          r.paidAt,
          r.channelCode,
          r.channelName,
          r.accountName,
          r.accountOwnerEmail ?? '',
          r.orderId,
          r.orderAmountCny.toFixed(2),
          r.ratePercent.toFixed(2),
          r.commissionCny.toFixed(2),
        ]
          .map(csvField)
          .join(','),
      );
    }
    // \r\n line endings + UTF-8 BOM make the file portable to Excel.
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }
}

function csvField(v: string | number): string {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
