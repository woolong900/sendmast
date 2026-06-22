import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AirwallexService } from './airwallex.service';
import { ShouqianbaService } from './shouqianba.service';
import { FxService } from '../fx/fx.service';
import { ReferralService } from '../referral/referral.service';
import type {
  CreateQuotaOrderResponse,
  QuotaPricingTierInput,
  QuotaPricingTierView,
  QuotaOrderView,
} from '@sendmast/shared';

/** A pending order older than this with no payment is considered abandoned. */
const STALE_ORDER_MS = 30 * 60 * 1000;
/** How often the background sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Past this age a pending order's QR is long dead — it can no longer be paid,
 * and the gateway may refuse to even query/cancel it (unknown/expired order, or
 * a legacy over-length client_sn). We still query once for a lost-notify PAID,
 * but if that can't be confirmed we close the order locally instead of retrying
 * the same doomed gateway calls forever (which would block deleting its tier).
 * Well beyond both the QR validity window and the notify-retry window, so a
 * real payment would already have been credited via notify or an earlier sweep.
 */
const HARD_EXPIRE_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class QuotaBillingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuotaBillingService.name);
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly airwallex: AirwallexService,
    private readonly shouqianba: ShouqianbaService,
    private readonly fx: FxService,
    private readonly config: ConfigService,
    private readonly referral: ReferralService,
  ) {}

  // ---------- Lifecycle: background stale-order sweep -------------------

  // Single-replica deployment, so a plain in-process timer is enough (no
  // external scheduler / cross-replica lock needed). If the API ever scales
  // horizontally, move this to a worker repeatable job or add a Redis lock so
  // it doesn't run on every replica.
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.sweepTimer = setInterval(() => {
      this.expireStalePendingOrders().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`stale-order sweep failed: ${msg}`);
      });
    }, SWEEP_INTERVAL_MS);
    // Don't keep the process alive just for this timer.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

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
    //
    // Proactively run the stale-order sweep for this tier first so an admin
    // isn't blocked waiting for the periodic one: abandoned unpaid orders get
    // closed (and any quietly-paid ones credited) here and now. Fresh pending
    // orders (< STALE_ORDER_MS old) are intentionally left alone — someone may
    // be mid-payment — so the guard below can still legitimately refuse.
    await this.expireStalePendingOrders({ tierId: id }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`deleteTier sweep failed for ${id}, proceeding to count: ${msg}`);
    });

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
    const provider =
      this.config.get<'shouqianba' | 'airwallex'>('QUOTA_PAYMENT_PROVIDER') ?? 'shouqianba';
    if (
      (provider === 'shouqianba' && !this.shouqianba.isConfigured()) ||
      (provider === 'airwallex' && !this.airwallex.isConfigured())
    ) {
      throw new ServiceUnavailableException('支付通道未配置,请联系平台管理员完成支付接入。');
    }
    if (provider === 'airwallex') await this.airwallex.ensurePaymentMethodAvailable();
    const tier = await this.prisma.quotaPricingTier.findUnique({ where: { id: args.tierId } });
    if (!tier || !tier.active) throw new BadRequestException('该档位不可用');

    const merchantOrderId = `sm${randomUUID().replace(/-/g, '').slice(0, 30)}`;

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
        provider,
        // Start with our merchant reference so the row exists before the
        // provider call. It is replaced by the PaymentIntent ID immediately
        // after creation, before the browser can enter checkout.
        providerOrderId: merchantOrderId,
        createdBy: args.userId,
      },
    });

    if (provider === 'shouqianba') {
      const apiBase = this.config.getOrThrow<string>('API_BASE_URL');
      const qrCode = await this.shouqianba.createQrCode({
        outTradeNo: merchantOrderId,
        totalAmountCny: amountCny,
        subject: `SendMast 发送额度 +${tier.emails.toLocaleString('en-US')}`,
        notifyUrl: `${apiBase}/api/payments/shouqianba/notify`,
        payway: args.channel === 'wechat' ? '3' : '1',
      });
      return {
        provider: 'shouqianba',
        orderId: merchantOrderId,
        qrCode,
        channel: args.channel,
        amountCny,
        amountUsd,
      };
    }

    const webBase = this.config.getOrThrow<string>('WEB_BASE_URL');
    let intent;
    try {
      intent = await this.airwallex.createPaymentIntent({
        requestId: randomUUID(),
        merchantOrderId,
        amountCny,
        returnUrl: `${webBase}/settings/orders`,
        description: `SendMast quota +${tier.emails}`,
      });
      if (!intent.clientSecret) {
        throw new ServiceUnavailableException('支付网关未返回收银台凭证');
      }
      await this.prisma.quotaOrder.update({
        where: { providerOrderId: merchantOrderId },
        data: { providerOrderId: intent.id },
      });
    } catch (err) {
      await this.prisma.quotaOrder.updateMany({
        where: { providerOrderId: merchantOrderId, status: 'pending' },
        data: { status: 'failed' },
      });
      throw err;
    }

    return {
      provider: 'airwallex',
      orderId: intent.id,
      clientSecret: intent.clientSecret,
      currency: 'CNY',
      environment: this.airwallex.checkoutEnvironment(),
      successUrl: `${webBase}/settings/orders?tradeNo=${encodeURIComponent(intent.id)}`,
      amountCny,
      amountUsd,
    };
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
    let row = await this.prisma.quotaOrder.findUnique({ where: { providerOrderId } });
    if (!row || row.accountId !== accountId) throw new NotFoundException('订单不存在');
    if (row.status === 'pending' && row.provider === 'airwallex') {
      await this.reconcileAirwallexOrder(row);
      row = await this.prisma.quotaOrder.findUnique({ where: { providerOrderId } });
      if (!row) throw new NotFoundException('订单不存在');
    }
    return this.toOrderView(row);
  }

  async handleAirwallexWebhook(rawBody: string): Promise<void> {
    let event: {
      name?: string;
      data?: { id?: string; object?: { id?: string } };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      this.logger.warn('Airwallex webhook: body is not valid JSON');
      return;
    }
    if (event.name !== 'payment_intent.succeeded') return;

    const intentId = event.data?.object?.id ?? event.data?.id;
    if (!intentId) {
      this.logger.warn('Airwallex webhook: succeeded event missing PaymentIntent ID');
      return;
    }
    const order = await this.prisma.quotaOrder.findUnique({
      where: { providerOrderId: intentId },
    });
    if (!order || order.provider !== 'airwallex' || order.status === 'paid') return;
    await this.reconcileAirwallexOrder(order);
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
      this.logger.log(`Shouqianba notify: ${outTradeNo} status=${truth.orderStatus}, no credit`);
      return 'success';
    }

    try {
      await this.creditPaidOrder(order, truth.tradeNo);
      return 'success';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Shouqianba notify processing failed: ${msg}`);
      return 'failure';
    }
  }

  /**
   * Flip a pending order → paid and credit the account's quota, exactly once.
   * Idempotent: the `status='pending'` guard inside the transaction means a
   * retried notify (or a concurrent sweep) that loses the race is a no-op.
   * Shared by the notify webhook and the stale-order sweep (the sweep also
   * uses it to recover payments whose notify never arrived).
   */
  private async creditPaidOrder(
    order: { id: string; providerOrderId: string; accountId: string; emails: number },
    tradeNo: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.quotaOrder.updateMany({
        where: { providerOrderId: order.providerOrderId, status: 'pending' },
        data: {
          status: 'paid',
          providerTradeNo: tradeNo,
          paidAt: new Date(),
        },
      });
      if (result.count !== 1) {
        this.logger.log(`creditPaidOrder: ${order.providerOrderId} already settled, skipping`);
        return;
      }
      await tx.account.update({
        where: { id: order.accountId },
        data: { sendQuotaRemaining: { increment: order.emails } },
      });
      // Referral commission. No-op for non-referred accounts; on retried
      // notifies the orderId UNIQUE constraint inside
      // recordCommissionForPaidOrder makes this idempotent. Errors there are
      // swallowed + logged so a referral bookkeeping failure never rolls back
      // the user's paid order.
      await this.referral.recordCommissionForPaidOrder(order.id, tx);
      this.logger.log(
        `creditPaidOrder: ${order.providerOrderId} credited ${order.emails} to account ${order.accountId}`,
      );
    });
  }

  private async reconcileAirwallexOrder(order: {
    id: string;
    providerOrderId: string;
    accountId: string;
    emails: number;
    amountCny: { toString(): string } | unknown;
  }): Promise<void> {
    let intent;
    try {
      intent = await this.airwallex.retrievePaymentIntent(order.providerOrderId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Airwallex reconcile failed for ${order.providerOrderId}: ${msg}`);
      return;
    }
    if (!intent) return;

    if (intent.status === 'SUCCEEDED') {
      const expectedAmount = Number((order.amountCny as { toString(): string }).toString());
      if (intent.currency !== 'CNY' || Math.abs(intent.amount - expectedAmount) > 0.001) {
        this.logger.error(
          `Airwallex amount mismatch for ${order.providerOrderId}: ` +
            `expected CNY ${expectedAmount}, got ${intent.currency} ${intent.amount}`,
        );
        return;
      }
      await this.creditPaidOrder(order, intent.latestPaymentAttemptId);
      return;
    }

    if (intent.status === 'CANCELLED') {
      await this.closeLocally(order.id);
    }
  }

  // ---------- Stale-order sweep -----------------------------------------

  /**
   * Close abandoned unpaid orders so they don't linger as `pending` forever
   * (which, among other things, blocks deleting the tier they point at).
   *
   * For each pending order older than `olderThanMs` we ask the gateway for the
   * authoritative status:
   *   - PAID            → credit it (also recovers a payment whose notify was lost).
   *   - anything else   → cancel at the gateway (so a late scan can't pay it),
   *                       then mark our order `cancelled`.
   *
   * If the gateway query or cancel fails we normally leave the order pending and
   * retry on the next sweep — never drop a possibly-payable order. The exception
   * is orders older than HARD_EXPIRE_MS: their QR is dead and the gateway may
   * reject query/cancel permanently (unknown/expired order, or a legacy
   * over-length client_sn), so retrying is futile and would pin the order
   * `pending` forever (blocking tier deletion). For those we still try the PAID
   * lookup, but otherwise close locally regardless of gateway failures.
   *
   * Safe to run repeatedly and concurrently (the credit path is idempotent).
   */
  async expireStalePendingOrders(opts?: {
    olderThanMs?: number;
    tierId?: string;
    limit?: number;
  }): Promise<{ checked: number; paid: number; cancelled: number }> {
    if (!this.airwallex.isConfigured() && !this.shouqianba.isConfigured()) {
      return { checked: 0, paid: 0, cancelled: 0 };
    }

    const cutoff = new Date(Date.now() - (opts?.olderThanMs ?? STALE_ORDER_MS));
    const stale = await this.prisma.quotaOrder.findMany({
      where: {
        status: 'pending',
        createdAt: { lt: cutoff },
        ...(opts?.tierId ? { tierId: opts.tierId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: opts?.limit ?? 100,
    });

    let paid = 0;
    let cancelled = 0;
    for (const order of stale) {
      if (order.provider === 'airwallex') {
        if (!this.airwallex.isConfigured()) continue;
        await this.reconcileAirwallexOrder(order);
        const current = await this.prisma.quotaOrder.findUnique({
          where: { id: order.id },
          select: { status: true },
        });
        if (current?.status === 'paid') {
          paid += 1;
          continue;
        }
        if (current?.status === 'cancelled') {
          cancelled += 1;
          continue;
        }

        // Airwallex only permits cancellation in specific pre-settlement
        // states. If it refuses, leave the order pending and retry later;
        // never close an asynchronously-processing payment locally.
        if (await this.airwallex.cancelPaymentIntent(order.providerOrderId)) {
          if (await this.closeLocally(order.id)) cancelled += 1;
        }
        continue;
      }

      if (!this.shouqianba.isConfigured()) continue;
      // Past this point the QR is dead; failed gateway calls must not pin the
      // order pending forever, so we close it locally instead of retrying.
      const hardExpired = order.createdAt.getTime() < Date.now() - HARD_EXPIRE_MS;

      let truth: { orderStatus: string; tradeNo: string | null } | null = null;
      try {
        truth = await this.shouqianba.queryOrder(order.providerOrderId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!hardExpired) {
          this.logger.warn(`sweep: query failed for ${order.providerOrderId}, will retry: ${msg}`);
          continue;
        }
        // Unrecoverable (gateway can't even query it) and long past payable —
        // close locally so it stops blocking tier deletion.
        this.logger.warn(
          `sweep: query failed for ${order.providerOrderId} but past hard-expire, closing locally: ${msg}`,
        );
        if (await this.closeLocally(order.id)) cancelled += 1;
        continue;
      }

      if (truth?.orderStatus === 'PAID') {
        try {
          await this.creditPaidOrder(order, truth.tradeNo);
          paid += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`sweep: credit failed for ${order.providerOrderId}: ${msg}`);
        }
        continue;
      }

      // Not paid (CREATED / PAY_CANCELED / PAY_ERROR / unknown). Close it at the
      // gateway first so it can't be paid late, only then mark ours cancelled.
      const closed = await this.shouqianba.cancelOrder(order.providerOrderId);
      if (!closed && !hardExpired) {
        this.logger.warn(`sweep: gateway cancel failed for ${order.providerOrderId}, will retry`);
        continue;
      }
      // Either the gateway confirmed cancel, or the order is past hard-expire so
      // a failed cancel no longer matters (the QR can't be paid). Close locally.
      if (await this.closeLocally(order.id)) cancelled += 1;
    }

    if (paid || cancelled) {
      this.logger.log(`sweep: checked=${stale.length} paid=${paid} cancelled=${cancelled}`);
    }
    return { checked: stale.length, paid, cancelled };
  }

  /** Flip a still-pending order → cancelled. Returns true if it was the one to
   *  flip it (guarded so a concurrent credit/cancel can't double-count). */
  private async closeLocally(orderId: string): Promise<boolean> {
    const res = await this.prisma.quotaOrder.updateMany({
      where: { id: orderId, status: 'pending' },
      data: { status: 'cancelled' },
    });
    return res.count === 1;
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
