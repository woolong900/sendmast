import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ShouqianbaService } from './shouqianba.service';
import { FxService } from '../fx/fx.service';
import type {
  CreateQuotaOrderResponse,
  QuotaPricingTierInput,
  QuotaPricingTierView,
  QuotaOrderView,
} from '@sendmast/shared';

@Injectable()
export class QuotaBillingService {
  private readonly logger = new Logger(QuotaBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shouqianba: ShouqianbaService,
    private readonly fx: FxService,
    private readonly config: ConfigService,
  ) {}

  // ---------- Tier read (user) ------------------------------------------

  async listActiveTiers(): Promise<QuotaPricingTierView[]> {
    const rows = await this.prisma.quotaPricingTier.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map((r) => this.toTierView(r));
  }

  // ---------- Tier admin CRUD -------------------------------------------

  async listAllTiers(): Promise<QuotaPricingTierView[]> {
    const rows = await this.prisma.quotaPricingTier.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toTierView(r));
  }

  async createTier(input: QuotaPricingTierInput): Promise<QuotaPricingTierView> {
    const row = await this.prisma.quotaPricingTier.create({
      data: {
        emails: input.emails,
        priceUsd: input.priceUsd,
        active: input.active,
        sortOrder: input.sortOrder,
      },
    });
    return this.toTierView(row);
  }

  async updateTier(id: string, input: QuotaPricingTierInput): Promise<QuotaPricingTierView> {
    try {
      const row = await this.prisma.quotaPricingTier.update({
        where: { id },
        data: {
          emails: input.emails,
          priceUsd: input.priceUsd,
          active: input.active,
          sortOrder: input.sortOrder,
        },
      });
      return this.toTierView(row);
    } catch {
      throw new NotFoundException('档位不存在');
    }
  }

  async toggleTier(id: string, active: boolean): Promise<void> {
    try {
      await this.prisma.quotaPricingTier.update({ where: { id }, data: { active } });
    } catch {
      throw new NotFoundException('档位不存在');
    }
  }

  async deleteTier(id: string): Promise<void> {
    // Tier delete cascades to nothing — orders carry tier_id ON DELETE SET
    // NULL so historical paid orders are still readable. Refuse only if
    // there are PENDING orders pointing at it (those would be orphaned).
    const pending = await this.prisma.quotaOrder.count({
      where: { tierId: id, status: 'pending' },
    });
    if (pending > 0) {
      throw new BadRequestException(`该档位还有 ${pending} 个待支付订单,无法删除。`);
    }
    try {
      await this.prisma.quotaPricingTier.delete({ where: { id } });
    } catch {
      throw new NotFoundException('档位不存在');
    }
  }

  // ---------- Order creation (user) -------------------------------------

  async createOrder(args: {
    accountId: string;
    userId: string;
    tierId: string;
    channel: 'alipay' | 'wechat';
  }): Promise<CreateQuotaOrderResponse> {
    if (!this.shouqianba.isConfigured()) {
      throw new ServiceUnavailableException(
        '支付通道未配置,请联系平台管理员完成支付接入。',
      );
    }
    const tier = await this.prisma.quotaPricingTier.findUnique({ where: { id: args.tierId } });
    if (!tier || !tier.active) throw new BadRequestException('该档位不可用');

    // client_sn (我们的 out_trade_no) must be ≤ 32 chars and unique per app_id.
    // UUID-no-dashes is 32 by itself — the `sm-` prefix would push us over,
    // so use a 28-char hex slice (still 112 bits of entropy, plenty unique).
    const outTradeNo = `sm${randomUUID().replace(/-/g, '').slice(0, 30)}`;

    const amountUsd = Number(tier.priceUsd);

    // Lock the FX rate at order creation so a rate change between user-
    // clicks-pay and the eventual notify doesn't desync the recorded
    // amount. FxService throws ServiceUnavailable if it has nothing
    // cached AND Frankfurter is unreachable — which surfaces as a clean
    // error rather than a silent mis-quote.
    const fx = await this.fx.getCurrentRate('USD', 'CNY');
    const amountCny = Math.round(amountUsd * fx.rate * 100) / 100;

    await this.prisma.quotaOrder.create({
      data: {
        accountId: args.accountId,
        tierId: tier.id,
        emails: tier.emails,
        amountUsd,
        amountCny,
        fxRate: fx.rate,
        provider: 'shouqianba',
        providerOrderId: outTradeNo,
        createdBy: args.userId,
      },
    });

    const apiBase = this.config.getOrThrow<string>('API_BASE_URL');
    const subject = `SendMast 发送额度 +${tier.emails.toLocaleString('en-US')}`;
    // 收钱吧 payway map: 1=支付宝, 3=微信. There's no "universal" code that
    // returns a multi-channel scannable QR — each precreate call yields a
    // QR that only the chosen wallet can read.
    const payway = args.channel === 'wechat' ? '3' : '1';
    const qrCode = await this.shouqianba.createQrCode({
      outTradeNo,
      totalAmountCny: amountCny,
      subject,
      notifyUrl: `${apiBase}/api/payments/shouqianba/notify`,
      payway,
    });

    return { orderId: outTradeNo, qrCode, channel: args.channel, amountCny, amountUsd };
  }

  // ---------- Order list (user) -----------------------------------------

  /** Lists ONLY paid orders — this powers the user-facing "我的订单" page,
   *  which is meant as a payment receipt history. Pending / failed /
   *  cancelled orders are noise here (the QR-pay modal handles the live
   *  state of an unfinished order, and abandoned drafts shouldn't pollute
   *  the receipt list). */
  async listMyOrders(accountId: string, limit = 50): Promise<QuotaOrderView[]> {
    const rows = await this.prisma.quotaOrder.findMany({
      where: { accountId, status: 'paid' },
      orderBy: { paidAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.toOrderView(r));
  }

  async getMyOrder(accountId: string, providerOrderId: string): Promise<QuotaOrderView> {
    const row = await this.prisma.quotaOrder.findUnique({ where: { providerOrderId } });
    if (!row || row.accountId !== accountId) throw new NotFoundException('订单不存在');
    return this.toOrderView(row);
  }

  // ---------- Notify webhook --------------------------------------------

  /**
   * Apply a Shouqianba async notify callback. MUST be idempotent —
   * Shouqianba retries until we ack with literal `success`. Idempotency
   * is enforced by `provider_order_id UNIQUE` and a `status='pending'`
   * filter inside the transaction (only flip `pending → paid` once).
   *
   * We do NOT trust the notify body's signature (Shouqianba signs with
   * RSA against an underdocumented public key). Instead we use the body
   * purely to learn WHICH order changed, then call the gateway's query
   * API as the authoritative source. Query is signed with our own
   * terminal_key, so the response is unforgeable. See ShouqianbaService
   * doc-comment for the full rationale.
   *
   * Returns:
   *   - 'success' → ack delivered, stop retries
   *   - 'failure' → unknown order / query said not-paid-yet / transport
   *                 hiccup; Shouqianba retries, which is fine since our
   *                 handler is no-op on already-processed orders.
   */
  async handleShouqianbaNotify(rawBody: string): Promise<'success' | 'failure'> {
    let payload: { client_sn?: string };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.logger.warn('Shouqianba notify: body is not valid JSON');
      return 'failure';
    }

    const outTradeNo = payload.client_sn;
    if (!outTradeNo) {
      this.logger.warn('Shouqianba notify: missing client_sn');
      return 'failure';
    }

    // Filter out fakes early: only query for client_sn values we actually
    // wrote ourselves. Cheap DB lookup, also serves as the must-exist check
    // for the credit transaction below.
    const order = await this.prisma.quotaOrder.findUnique({
      where: { providerOrderId: outTradeNo },
    });
    if (!order) {
      this.logger.warn(`Shouqianba notify: unknown client_sn ${outTradeNo} (ignoring)`);
      return 'failure';
    }
    if (order.status === 'paid') {
      this.logger.log(`Shouqianba notify: ${outTradeNo} already paid, skipping`);
      return 'success';
    }

    let truth: { orderStatus: string; tradeNo: string | null } | null;
    try {
      truth = await this.shouqianba.queryOrder(outTradeNo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Shouqianba notify: query failed for ${outTradeNo}: ${msg}`);
      return 'failure';
    }
    if (!truth) {
      this.logger.warn(`Shouqianba notify: gateway has no record of ${outTradeNo}`);
      return 'failure';
    }
    if (truth.orderStatus !== 'PAID') {
      // Common when notify lands on a non-payment transition (e.g.
      // PAY_CANCELED). Ack-success so retries stop; account untouched.
      this.logger.log(
        `Shouqianba notify: ${outTradeNo} status=${truth.orderStatus}, no credit`,
      );
      return 'success';
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const result = await tx.quotaOrder.updateMany({
          where: { providerOrderId: outTradeNo, status: 'pending' },
          data: {
            status: 'paid',
            providerTradeNo: truth.tradeNo,
            paidAt: new Date(),
          },
        });
        if (result.count !== 1) {
          this.logger.log(`Shouqianba notify: ${outTradeNo} won by another worker`);
          return;
        }
        await tx.account.update({
          where: { id: order.accountId },
          data: { sendQuotaRemaining: { increment: order.emails } },
        });
        this.logger.log(
          `Shouqianba notify: ${outTradeNo} credited ${order.emails} to account ${order.accountId}`,
        );
      });
      return 'success';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Shouqianba notify processing failed: ${msg}`);
      return 'failure';
    }
  }

  // ---------- Mappers ---------------------------------------------------

  private toTierView(r: {
    id: string;
    emails: number;
    priceUsd: { toString(): string } | unknown;
    active: boolean;
    sortOrder: number;
    updatedAt: Date;
  }): QuotaPricingTierView {
    const priceUsd = Number((r.priceUsd as { toString(): string }).toString());
    return {
      id: r.id,
      emails: r.emails,
      priceUsd,
      // Round to 6 sig figs so the UI's "$0.0018/封" shows cleanly without
      // floating-point fuzz like 0.0018000000000000002.
      unitPriceUsd: Number((priceUsd / r.emails).toPrecision(4)),
      active: r.active,
      sortOrder: r.sortOrder,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toOrderView(r: {
    id: string;
    emails: number;
    amountUsd: { toString(): string } | unknown;
    amountCny: { toString(): string } | unknown;
    fxRate: { toString(): string } | unknown;
    status: string;
    provider: string;
    providerOrderId: string;
    paidAt: Date | null;
    createdAt: Date;
  }): QuotaOrderView {
    return {
      id: r.id,
      emails: r.emails,
      amountUsd: Number((r.amountUsd as { toString(): string }).toString()),
      amountCny: Number((r.amountCny as { toString(): string }).toString()),
      fxRate: Number((r.fxRate as { toString(): string }).toString()),
      status: r.status as QuotaOrderView['status'],
      provider: r.provider,
      providerOrderId: r.providerOrderId,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
