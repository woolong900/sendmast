import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type {
  ShopAutomation,
  ShopAutomationStep,
  ShopAutomationType,
  ShopConnection,
} from '@prisma/client';
import {
  exchangeAuthorizeToken,
  ShopyyAuthError,
  ShopyyClient,
  ShopyyError,
} from '@sendmast/shopyy';
import { getAutomationEngagement } from '@sendmast/clickhouse';
import { ClickHouseService } from '../../common/clickhouse/clickhouse.service';
import {
  SHOP_AUTOMATION_TYPES,
  type ConnectShopyyInput,
  type CouponDiscountKind,
  type FlowStatsView,
  type ShopAutomationType as ShopAutomationTypeDto,
  type ShopAutomationView,
  type ShopConnectionView,
  type ShopCouponView,
  type UpdateShopAutomationInput,
} from '@sendmast/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Webhook events we subscribe the store to. `eventId` is the shopyy event id
 * (from `GET /webhooks/events`); `topic` is the value we encode in the callback
 * URL (`?topic=`) so the receiver knows the event without relying on shopyy's
 * inbound headers/body. shopyy has no abandoned-checkout event, so we instead
 * subscribe to order creation: every created order is recorded, and the
 * `abandoned_cart` automation re-checks it `delayMinutes` later — if still
 * unpaid, the recall fires. This avoids polling the order list via the OpenAPI.
 */
const SHOPYY_WEBHOOK_EVENTS: ReadonlyArray<{
  eventId: number;
  topic: string;
  name: string;
}> = [
  { eventId: 4, topic: 'orders/create', name: 'SendMast 订单创建' },
  { eventId: 5, topic: 'orders/paid', name: 'SendMast 订单支付' },
  { eventId: 7, topic: 'orders/fulfilled', name: 'SendMast 订单发货' },
];

/**
 * System default template the abandoned-cart flow is pre-pointed at (seeded by
 * the `abandoned_cart_default_template` migration). New abandoned_cart
 * automations adopt it so the flow is ready to enable without first authoring a
 * template.
 */
const ABANDONED_CART_DEFAULT_TEMPLATE_ID = '00000000-0000-4000-8000-000000000004';
const ABANDONED_CART_DEFAULT_SUBJECT = 'Complete your purchase';

/** shopyy `expired_at` may be Unix seconds, ms, or an ISO string. */
function parseExpiredAt(v: string | number | undefined): Date | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms);
  }
  const n = Number(v);
  if (!Number.isNaN(n)) return parseExpiredAt(n);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toAutomationView(
  a: ShopAutomation,
  steps: ShopAutomationStep[],
  stats: FlowStatsView,
): ShopAutomationView {
  return {
    id: a.id,
    type: a.type,
    enabled: a.enabled,
    templateId: a.templateId,
    senderDomainId: a.senderDomainId,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    subject: a.subject,
    delayMinutes: a.delayMinutes,
    steps: steps
      .slice()
      .sort((x, y) => x.stepIndex - y.stepIndex)
      .map((s) => ({
        id: s.id,
        stepIndex: s.stepIndex,
        templateId: s.templateId,
        subject: s.subject,
        couponCode: s.couponCode,
        couponDiscountKind: (s.couponDiscountKind as CouponDiscountKind | null) ?? null,
        couponDiscountValue: s.couponDiscountValue,
        delayMinutes: s.delayMinutes,
      })),
    stats,
  };
}


function toView(c: ShopConnection): ShopConnectionView {
  return {
    id: c.id,
    provider: c.provider,
    externalStoreId: c.externalStoreId,
    shopName: c.shopName,
    shopDomain: c.shopDomain,
    mainDomain: c.mainDomain,
    status: c.status,
    storeExpiredAt: c.storeExpiredAt ? c.storeExpiredAt.toISOString() : null,
    connectedAt: c.connectedAt.toISOString(),
    lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
  };
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ch: ClickHouseService,
  ) {}

  /** Whether the partnership app secret is present (gates the connect flow). */
  isConfigured(): boolean {
    return !!this.config.get<string>('SHOPYY_APP_SECRET');
  }

  async listConnections(
    accountId: string,
  ): Promise<{ configured: boolean; connections: ShopConnectionView[] }> {
    const rows = await this.prisma.shopConnection.findMany({
      where: { accountId },
      orderBy: { connectedAt: 'desc' },
    });
    return { configured: this.isConfigured(), connections: rows.map(toView) };
  }

  /**
   * Complete the authorize exchange and bind the store to `accountId`. Called
   * by the SPA after shopyy redirects the merchant back with `code` +
   * `authorize_token_url`.
   */
  async connectShopyy(
    accountId: string,
    input: ConnectShopyyInput,
  ): Promise<ShopConnectionView> {
    const secret = this.config.get<string>('SHOPYY_APP_SECRET');
    if (!secret) {
      throw new BadRequestException(
        'Shopyy 集成尚未配置：缺少应用密钥（SHOPYY_APP_SECRET），请联系管理员',
      );
    }
    const appKey = this.config.get<string>('SHOPYY_APP_KEY');

    let result;
    try {
      result = await exchangeAuthorizeToken({
        authorizeTokenUrl: input.authorizeTokenUrl,
        code: input.code,
        secret,
        extraParams: appKey ? { app_key: appKey } : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ShopyyAuthError) {
        throw new BadRequestException(`Shopyy 授权失败：${msg}`);
      }
      throw new BadRequestException(`Shopyy 授权换取失败：${msg}`);
    }

    const externalStoreId = String(result.store.id);
    const existing = await this.prisma.shopConnection.findUnique({
      where: { provider_externalStoreId: { provider: 'shopyy', externalStoreId } },
    });
    if (existing && existing.accountId !== accountId) {
      throw new ConflictException('该店铺已绑定到其他账户');
    }

    const webhookSecret = existing?.webhookSecret ?? randomBytes(24).toString('hex');
    const data = {
      shopName: result.store.shop_name ?? null,
      shopDomain: result.store.shop_domain ?? null,
      mainDomain: result.store.main_domain ?? null,
      brandId: result.store.brand_id != null ? String(result.store.brand_id) : null,
      timeZone: result.store.time_zone ?? null,
      openapiDomain: result.developer_app.openapi_domain,
      webhookBaseurl: result.developer_app.webhook_baseurl ?? null,
      appExternalId: result.app?.id != null ? String(result.app.id) : null,
      appKey: result.app?.key ?? null,
      appName: result.app?.name ?? null,
      devToken: result.developer_app.token,
      webhookSecret,
      status: 'active' as const,
      storeExpiredAt: parseExpiredAt(result.store.expired_at),
    };

    // Webhooks are the whole point of the integration — a store with none isn't
    // usable — so treat install failure as a bind failure rather than silently
    // persisting a misleading "active" connection. Install first using the
    // freshly-exchanged credentials; only persist once webhooks are in place.
    try {
      await this.installWebhooks({
        externalStoreId,
        openapiDomain: data.openapiDomain,
        devToken: data.devToken,
        webhookSecret,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Shopyy webhook install failed for store ${externalStoreId}: ${reason}`);
      throw new BadRequestException(
        `店铺授权成功，但创建 Webhook 失败：${reason}。请稍后重试，或检查应用的事件授权与 API IP 白名单。`,
      );
    }

    const conn = await this.prisma.shopConnection.upsert({
      where: { provider_externalStoreId: { provider: 'shopyy', externalStoreId } },
      create: {
        accountId,
        provider: 'shopyy',
        externalStoreId,
        connectedAt: new Date(),
        ...data,
      },
      update: { ...data, connectedAt: new Date() },
    });

    return toView(conn);
  }

  private async installWebhooks(conn: {
    externalStoreId: string;
    openapiDomain: string;
    devToken: string;
    webhookSecret: string;
  }): Promise<void> {
    const rawBase =
      this.config.get<string>('SHOPYY_WEBHOOK_BASE_URL') ??
      `${this.config.getOrThrow<string>('API_BASE_URL')}/api`;
    const base = rawBase.replace(/\/+$/, '');
    const client = new ShopyyClient({
      openapiDomain: conn.openapiDomain,
      token: conn.devToken,
    });

    // Reuse an existing webhook row for the same event when it already points at
    // our receiver, so re-connecting edits in place instead of duplicating
    // (duplicates would double-send the transactional emails).
    const existing = await client.listWebhooks().catch(() => [] as Awaited<
      ReturnType<typeof client.listWebhooks>
    >);
    const ourPrefix = `${base}/webhooks/shopyy`;

    const items = SHOPYY_WEBHOOK_EVENTS.map((e) => {
      // Per-store opaque key authenticates inbound webhooks; topic is encoded so
      // the receiver knows the event without trusting shopyy's inbound shape.
      // Store identity is read from the payload's `store_id` at receive time, so
      // the URL only carries `key` (auth) + `topic` (which event fired). The
      // topic is a fixed safe constant (`orders/create` etc.), so we leave its
      // `/` literal rather than percent-encoding it to `%2F` — both decode the
      // same at the receiver, but the literal slash reads cleaner.
      const url =
        `${ourPrefix}` +
        `?key=${conn.webhookSecret}` +
        `&topic=${e.topic}`;
      const prior = existing.find(
        (w) => w.event_id === e.eventId && typeof w.url === 'string' && w.url.startsWith(ourPrefix),
      );
      return {
        ...(prior ? { id: prior.id } : {}),
        webhookName: e.name,
        url,
        eventId: e.eventId,
      };
    });

    try {
      await client.batchSaveWebhooks(items);
    } catch (batchErr) {
      // batchsave is atomic: one event_id that's invalid for this store's plan
      // (e.g. 36 = single-page checkout, absent on some stores) rejects the
      // WHOLE batch, so no webhooks get created. Fall back to per-event saves
      // so the valid events still register; skip (log) only the bad ones.
      const results = await Promise.allSettled(
        items.map((it) => client.batchSaveWebhooks([it])),
      );
      const failures = results.flatMap((r, i) =>
        r.status === 'rejected' ? [{ event: SHOPYY_WEBHOOK_EVENTS[i]!, reason: r.reason }] : [],
      );
      // Every event failed → real problem (auth/IP/etc.); surface to caller.
      if (failures.length === items.length) throw batchErr;
      for (const f of failures) {
        this.logger.warn(
          `Shopyy webhook skipped event ${f.event.eventId} (${f.event.name}) for store ${conn.externalStoreId}: ${
            f.reason instanceof Error ? f.reason.message : f.reason
          }`,
        );
      }
    }
  }

  /** PG sent count + ClickHouse engagement for one flow. Best-effort on CH outage. */
  private async automationStats(
    accountId: string,
    automationId: string,
  ): Promise<FlowStatsView> {
    const [sent, engagement] = await Promise.all([
      this.prisma.shopAutomationSend.count({
        where: { automationId, status: 'sent' },
      }),
      getAutomationEngagement(this.ch.client, { accountId, automationId }).catch(() => ({
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
      })),
    ]);
    return { sent, ...engagement };
  }

  /** Verify the store belongs to this tenant; throws 404 otherwise. */
  private async assertConnection(
    accountId: string,
    connectionId: string,
  ): Promise<ShopConnection> {
    const conn = await this.prisma.shopConnection.findFirst({
      where: { id: connectionId, accountId },
    });
    if (!conn) throw new NotFoundException('店铺连接不存在');
    return conn;
  }

  /**
   * Return the three fixed automations for a store, lazily creating any that
   * don't yet exist so the settings UI always renders all three cards.
   */
  async listAutomations(
    accountId: string,
    connectionId: string,
  ): Promise<ShopAutomationView[]> {
    await this.assertConnection(accountId, connectionId);
    const existing = await this.prisma.shopAutomation.findMany({
      where: { shopConnectionId: connectionId },
    });
    const byType = new Map(existing.map((a) => [a.type, a]));
    const missing = SHOP_AUTOMATION_TYPES.filter((t) => !byType.has(t));
    if (missing.length) {
      await this.prisma.shopAutomation.createMany({
        data: missing.map((type) => ({
          accountId,
          shopConnectionId: connectionId,
          type: type as ShopAutomationType,
          // Pre-point the abandoned-cart flow at the system default template so
          // it only needs a verified sender before it can be enabled.
          ...(type === 'abandoned_cart'
            ? {
                templateId: ABANDONED_CART_DEFAULT_TEMPLATE_ID,
                subject: ABANDONED_CART_DEFAULT_SUBJECT,
              }
            : {}),
        })),
        skipDuplicates: true,
      });
    }
    const rows = await this.prisma.shopAutomation.findMany({
      where: { shopConnectionId: connectionId },
    });
    const order = SHOP_AUTOMATION_TYPES;
    rows.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

    // abandoned_cart is multi-round; ensure it always has at least round 1 so
    // the UI renders an editable round and legacy single-config keeps working.
    const abandoned = rows.find((a) => a.type === 'abandoned_cart');
    if (abandoned) await this.ensureAbandonedStep(abandoned);
    const stepsByAutomation = abandoned
      ? await this.prisma.shopAutomationStep.findMany({
          where: { automationId: abandoned.id },
          orderBy: { stepIndex: 'asc' },
        })
      : [];

    return Promise.all(
      rows.map(async (a) =>
        toAutomationView(
          a,
          a.type === 'abandoned_cart' ? stepsByAutomation : [],
          await this.automationStats(accountId, a.id),
        ),
      ),
    );
  }

  /** Seed round 1 from the automation's own config when it has no steps yet. */
  private async ensureAbandonedStep(a: ShopAutomation): Promise<void> {
    const count = await this.prisma.shopAutomationStep.count({
      where: { automationId: a.id },
    });
    if (count > 0) return;
    await this.prisma.shopAutomationStep.create({
      data: {
        automationId: a.id,
        stepIndex: 1,
        templateId: a.templateId,
        subject: a.subject,
        // Round 1 default: 30 minutes after order creation.
        delayMinutes: 30,
      },
    });
  }

  async updateAutomation(
    accountId: string,
    connectionId: string,
    type: ShopAutomationTypeDto,
    input: UpdateShopAutomationInput,
  ): Promise<ShopAutomationView> {
    const conn = await this.assertConnection(accountId, connectionId);
    const isAbandoned = type === 'abandoned_cart';
    const { steps, ...rest } = input;

    const existing = await this.prisma.shopAutomation.findUnique({
      where: {
        shopConnectionId_type: {
          shopConnectionId: connectionId,
          type: type as ShopAutomationType,
        },
      },
    });

    // Resolve the effective rounds for the enable check (incoming overrides the
    // stored rounds; fall back to stored when the payload omits `steps`).
    let effectiveSteps = steps;
    if (isAbandoned && !effectiveSteps && existing) {
      const cur = await this.prisma.shopAutomationStep.findMany({
        where: { automationId: existing.id },
        orderBy: { stepIndex: 'asc' },
      });
      effectiveSteps = cur.map((s) => ({
        templateId: s.templateId,
        subject: s.subject,
        delayMinutes: s.delayMinutes,
      }));
    }

    // Enabling requires a deliverable config: a verified sender + a template
    // (every round for abandoned_cart, the single template otherwise).
    if (input.enabled) {
      // No usable store binding → the flow could never fire (no webhooks).
      // Revoked = unbound; expired = token dead until re-authorized.
      if (conn.status !== 'active') {
        throw new BadRequestException(
          conn.status === 'expired'
            ? '店铺授权已过期，请先重新授权店铺后再开启自动化'
            : '店铺未绑定，请先连接店铺后再开启自动化',
        );
      }
      const fromEmail = rest.fromEmail ?? existing?.fromEmail;
      if (!fromEmail) throw new BadRequestException('启用前请先选择发件邮箱');
      if (isAbandoned) {
        if (!effectiveSteps?.length || effectiveSteps.some((s) => !s.templateId)) {
          throw new BadRequestException('启用前请为每一轮选择邮件模板');
        }
      } else if (!(rest.templateId ?? existing?.templateId)) {
        throw new BadRequestException('启用前请先选择邮件模板');
      }
    }

    // For abandoned_cart, mirror round 1 onto the parent so legacy reads and
    // the worker's fallback path keep resolving a sensible template/subject.
    const first = isAbandoned ? steps?.[0] : undefined;
    const parentData = first
      ? {
          ...rest,
          templateId: first.templateId ?? null,
          subject: first.subject ?? null,
          delayMinutes: first.delayMinutes,
        }
      : rest;

    const updated = await this.prisma.$transaction(async (tx) => {
      const a = await tx.shopAutomation.upsert({
        where: {
          shopConnectionId_type: {
            shopConnectionId: connectionId,
            type: type as ShopAutomationType,
          },
        },
        create: {
          accountId,
          shopConnectionId: connectionId,
          type: type as ShopAutomationType,
          ...parentData,
        },
        update: { ...parentData },
      });
      if (isAbandoned && steps) {
        await tx.shopAutomationStep.deleteMany({ where: { automationId: a.id } });
        await tx.shopAutomationStep.createMany({
          data: steps.map((s, i) => {
            const couponCode = s.couponCode?.trim() || null;
            return {
              automationId: a.id,
              stepIndex: i + 1,
              templateId: s.templateId ?? null,
              subject: s.subject ?? null,
              couponCode,
              // Only keep the discount snapshot when a coupon is actually set.
              couponDiscountKind: couponCode ? s.couponDiscountKind ?? null : null,
              couponDiscountValue: couponCode ? s.couponDiscountValue ?? null : null,
              delayMinutes: s.delayMinutes,
            };
          }),
        });
      }
      return a;
    });

    const stepRows = isAbandoned
      ? await this.prisma.shopAutomationStep.findMany({
          where: { automationId: updated.id },
          orderBy: { stepIndex: 'asc' },
        })
      : [];
    return toAutomationView(
      updated,
      stepRows,
      await this.automationStats(accountId, updated.id),
    );
  }

  /**
   * List the connected store's coupons for the per-round coupon picker. Hits
   * the OpenAPI live (coupons change often, not worth caching). De-dupes by
   * code and drops codeless rows. Requires the app's coupon API scope — without
   * it shopyy answers `503 权限验证失败`, surfaced here as a clear 400.
   */
  async listCoupons(accountId: string, connectionId: string): Promise<ShopCouponView[]> {
    const conn = await this.assertConnection(accountId, connectionId);
    if (!conn.openapiDomain || !conn.devToken) {
      throw new BadRequestException('店铺连接缺少 API 凭证，请重新授权店铺');
    }
    const client = new ShopyyClient({
      openapiDomain: conn.openapiDomain,
      token: conn.devToken,
    });
    let coupons;
    try {
      coupons = await client.listCoupons();
    } catch (err) {
      if (err instanceof ShopyyAuthError) {
        throw new BadRequestException('店铺授权已失效，请重新授权后再拉取优惠券');
      }
      const msg = err instanceof ShopyyError ? err.message : String(err);
      throw new BadRequestException(
        `拉取优惠券失败：${msg}。若提示权限验证失败，请在 Shopyy 开发者后台为应用开通「优惠券」接口权限。`,
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const out: ShopCouponView[] = [];
    for (const c of coupons) {
      const code = c.coupon_code?.trim();
      if (!code || seen.has(code)) continue;
      // Drop already-expired coupons (ends_at in the past); -1/absent = forever.
      if (typeof c.ends_at === 'number' && c.ends_at > 0 && c.ends_at < nowSec) continue;
      seen.add(code);
      // discount.type: 1 = percent off, 2 = fixed amount off (confirmed against
      // live store data); anything else → unknown, render the generic card.
      const dt = c.param?.discount?.type;
      const dv = c.param?.discount?.value;
      const discountKind: CouponDiscountKind | null =
        dt === 1 ? 'percent' : dt === 2 ? 'amount' : null;
      out.push({
        code,
        name: c.coupon_name?.trim() || code,
        discountKind,
        discountValue: discountKind && typeof dv === 'number' ? dv : null,
      });
    }
    return out;
  }

  async disconnect(accountId: string, id: string): Promise<{ ok: true }> {
    const conn = await this.prisma.shopConnection.findFirst({
      where: { id, accountId },
    });
    if (!conn) throw new NotFoundException('店铺连接不存在');
    // Soft-revoke: keep the row (and its orders/automations) for history; the
    // connection just stops being usable until re-authorized.
    await this.prisma.shopConnection.update({
      where: { id },
      data: { status: 'revoked' },
    });
    return { ok: true };
  }
}
