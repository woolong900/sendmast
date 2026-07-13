import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
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
  type ShopyyStoreDomain,
} from '@sendmast/shopyy';
import { getAutomationEngagement } from '@sendmast/clickhouse';
import { ClickHouseService } from '../../common/clickhouse/clickhouse.service';
import {
  SHOP_AUTOMATION_TYPES,
  type ConnectShopyyInput,
  type CouponDiscountKind,
  type FlowStatsView,
  type ShopAutomationType as ShopAutomationTypeDto,
  type ShopAutomationSendListResponse,
  type ShopAutomationSendQuery,
  type ShopConnectionHealthView,
  type ShopAutomationView,
  type ShopConnectionView,
  type ShopCouponView,
  type ShopSyncJob,
  type UpdateShopConnectionInput,
  type UpdateShopAutomationInput,
} from '@sendmast/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../../common/queue/queue.service';

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
  { eventId: 1, topic: 'customers/create', name: 'SendMast 顾客创建' },
  { eventId: 4, topic: 'orders/create', name: 'SendMast 订单创建' },
  { eventId: 5, topic: 'orders/paid', name: 'SendMast 订单支付' },
  { eventId: 7, topic: 'orders/fulfilled', name: 'SendMast 订单发货' },
  // Single-page checkout order creation; not available on every store's plan —
  // installWebhooks' per-event fallback skips it where the batch rejects.
  { eventId: 36, topic: 'orderonepeges/create', name: 'SendMast 订单创建（单页流程）' },
];

/**
 * Name of the auto-created per-tenant list that mirrors the store's customer
 * base ("店铺客户"). Created on first store bind, then kept current by the
 * `customers/create` webhook, order webhooks, and the initial full sync.
 */
const SHOP_CUSTOMER_LIST_NAME = '店铺客户';

/**
 * System default template the abandoned-cart flow is pre-pointed at (seeded by
 * the `abandoned_cart_default_template` migration). New abandoned_cart
 * automations adopt it so the flow is ready to enable without first authoring a
 * template.
 */
const ABANDONED_CART_DEFAULT_TEMPLATE_ID = '00000000-0000-4000-8000-000000000004';
const ABANDONED_CART_DEFAULT_SUBJECT = 'Complete your purchase';

/**
 * System default template per flow type (seeded by migrations). The first time
 * an automation/round is rendered for the UI we copy this template's content
 * inline so each flow becomes self-contained and editable in place.
 */
const DEFAULT_TEMPLATE_ID: Record<ShopAutomationType, string> = {
  customer_registered: '00000000-0000-4000-8000-000000000007',
  order_paid: '00000000-0000-4000-8000-000000000005',
  order_shipped: '00000000-0000-4000-8000-000000000006',
  abandoned_cart: ABANDONED_CART_DEFAULT_TEMPLATE_ID,
};

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

function normaliseStoreUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function domainValue(row: ShopyyStoreDomain): string | null {
  return row.domain ?? row.domain_name ?? row.host ?? row.url ?? null;
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
    html: a.html,
    designJson: a.designJson ?? null,
    thumbnail: a.thumbnail,
    preheader: a.preheader,
    senderDomainId: a.senderDomainId,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    subject: a.subject,
    couponCode: a.couponCode,
    couponDiscountKind: (a.couponDiscountKind as CouponDiscountKind | null) ?? null,
    couponDiscountValue: a.couponDiscountValue,
    delayMinutes: a.delayMinutes,
    steps: steps
      .slice()
      .sort((x, y) => x.stepIndex - y.stepIndex)
      .map((s) => ({
        id: s.id,
        stepIndex: s.stepIndex,
        templateId: s.templateId,
        html: s.html,
        designJson: s.designJson ?? null,
        thumbnail: s.thumbnail,
        preheader: s.preheader,
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
    storeUrl: c.storeUrl,
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
    private readonly queue: QueueService,
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

  async updateConnection(
    accountId: string,
    connectionId: string,
    input: UpdateShopConnectionInput,
  ): Promise<ShopConnectionView> {
    await this.assertConnection(accountId, connectionId);
    const raw = input.storeUrl?.trim() ?? '';
    const storeUrl = raw
      ? new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString()
      : null;
    const updated = await this.prisma.shopConnection.update({
      where: { id: connectionId },
      data: { storeUrl },
    });
    return toView(updated);
  }

  /**
   * Complete the authorize exchange and bind the store to `accountId`. Called
   * by the SPA after shopyy redirects the merchant back with `code` +
   * `authorize_token_url`.
   */
  async connectShopyy(accountId: string, input: ConnectShopyyInput): Promise<ShopConnectionView> {
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
        partnerId: this.config.get<string>('SHOPYY_PARTNER_ID'),
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
    const detectedStoreUrl =
      (await this.fetchStoreUrlFromDomains(
        result.developer_app.openapi_domain,
        result.developer_app.token,
        externalStoreId,
      )) ??
      existing?.storeUrl ??
      null;
    const data = {
      shopName: result.store.shop_name ?? null,
      shopDomain: result.store.shop_domain ?? null,
      mainDomain: result.store.main_domain ?? null,
      storeUrl: detectedStoreUrl,
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
    let webhookIds: number[];
    try {
      webhookIds = await this.installWebhooks({
        externalStoreId,
        openapiDomain: data.openapiDomain,
        devToken: data.devToken,
        webhookSecret,
        appId: result.app.id,
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
        webhookIds,
        ...data,
      },
      update: { ...data, webhookIds, connectedAt: new Date() },
    });

    // Auto-provision the tenant's "店铺客户" contact list and remember it on the
    // connection. The webhook handlers and the initial sync below funnel every
    // store customer into this list.
    if (!conn.customerListId) {
      const list = await this.prisma.contactList.upsert({
        where: { accountId_name: { accountId, name: SHOP_CUSTOMER_LIST_NAME } },
        create: {
          accountId,
          name: SHOP_CUSTOMER_LIST_NAME,
          description: '绑定店铺后自动创建：店铺的全部客户（自动同步）',
        },
        update: {},
      });
      await this.prisma.shopConnection.update({
        where: { id: conn.id },
        data: { customerListId: list.id },
      });
    }

    // Provision all supported flows and snapshot the latest system templates
    // immediately. Webhooks are already live at this point, so waiting for the
    // merchant to visit the automation page would create a window where early
    // store events have no flow configuration to resolve.
    await this.provisionAutomations(accountId, conn.id);

    // Kick off the initial full sync in the background: pull every store
    // customer into the list, and every paid order into shop_orders (used to
    // match "已下单" customers when building dynamic segments). Idempotent, so
    // a re-connect just re-runs it. Bind already succeeded — don't fail it on
    // a queueing hiccup.
    try {
      await this.queue.add(QueueService.names.SHOP_SYNC, 'initial-sync', {
        connectionId: conn.id,
        accountId,
      } satisfies ShopSyncJob);
    } catch (e) {
      this.logger.warn(
        `Shopyy initial sync enqueue failed for store ${externalStoreId}: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }

    return toView(conn);
  }

  /** Build a ShopyyClient with the partner identification header attached. */
  private shopyyClient(openapiDomain: string, token: string): ShopyyClient {
    return new ShopyyClient({
      openapiDomain,
      token,
      partnerId: this.config.get<string>('SHOPYY_PARTNER_ID'),
    });
  }

  private shopyyWebhookReceiverUrl(): string {
    const rawBase =
      this.config.get<string>('SHOPYY_WEBHOOK_BASE_URL') ??
      `${this.config.getOrThrow<string>('API_BASE_URL')}/api`;
    return `${rawBase.replace(/\/+$/, '')}/webhooks/shopyy`;
  }

  private async fetchStoreUrlFromDomains(
    openapiDomain: string,
    token: string,
    externalStoreId: string,
  ): Promise<string | null> {
    try {
      const domains = await this.shopyyClient(openapiDomain, token).listStoreDomains({
        status: 1,
        httpsStatus: 1,
      });
      for (const domain of domains) {
        const storeUrl = normaliseStoreUrl(domainValue(domain));
        if (storeUrl) return storeUrl;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `Shopyy store domain lookup failed for store ${externalStoreId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return null;
    }
  }

  private async installWebhooks(conn: {
    externalStoreId: string;
    openapiDomain: string;
    devToken: string;
    webhookSecret: string;
    appId: string | number;
  }): Promise<number[]> {
    const client = this.shopyyClient(conn.openapiDomain, conn.devToken);

    // Reuse an existing webhook row for the same event when it already points at
    // our receiver, so re-connecting edits in place instead of duplicating
    // (duplicates would double-send the transactional emails).
    const existing = await client
      .listWebhooks()
      .catch(() => [] as Awaited<ReturnType<typeof client.listWebhooks>>);
    const ourPrefix = this.shopyyWebhookReceiverUrl();

    const items = SHOPYY_WEBHOOK_EVENTS.map((e) => {
      // Per-store opaque key authenticates inbound webhooks; topic is encoded so
      // the receiver knows the event without trusting shopyy's inbound shape.
      // Store identity is read from the payload's `store_id` at receive time, so
      // the URL only carries `key` (auth) + `topic` (which event fired). The
      // topic is a fixed safe constant (`orders/create` etc.), so we leave its
      // `/` literal rather than percent-encoding it to `%2F` — both decode the
      // same at the receiver, but the literal slash reads cleaner.
      const url = `${ourPrefix}` + `?key=${conn.webhookSecret}` + `&topic=${e.topic}`;
      const prior = existing.find(
        (w) => w.event_id === e.eventId && typeof w.url === 'string' && w.url.startsWith(ourPrefix),
      );
      return {
        ...(prior ? { id: prior.id } : {}),
        webhookName: e.name,
        url,
        eventId: e.eventId,
        fromId: conn.appId,
      };
    });

    try {
      await client.batchSaveWebhooks(items);
    } catch (batchErr) {
      // batchsave is atomic: one event_id that's invalid for this store's plan
      // (e.g. 36 = single-page checkout, absent on some stores) rejects the
      // WHOLE batch, so no webhooks get created. Fall back to per-event saves
      // so the valid events still register; skip (log) only the bad ones.
      const results = await Promise.allSettled(items.map((it) => client.batchSaveWebhooks([it])));
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

    // batchsave's response shape is not stable across Shopyy gateways. Read the
    // canonical list back and persist the IDs matching the exact URLs from this
    // install attempt.
    const installedUrls = new Set(items.map((item) => item.url));
    const webhookIds = (await client.listWebhooks())
      .filter((webhook) => installedUrls.has(webhook.url))
      .map((webhook) => webhook.id);
    if (webhookIds.length === 0) {
      throw new ShopyyError('created webhooks could not be found after batchsave', 'not-found');
    }
    return webhookIds;
  }

  private async uninstallWebhooks(conn: ShopConnection): Promise<void> {
    if (!conn.openapiDomain || !conn.devToken) {
      this.logger.warn(
        `Skipping Shopyy webhook deletion for store ${conn.externalStoreId}: missing API credentials`,
      );
      return;
    }

    if (conn.webhookIds.length === 0) {
      this.logger.warn(
        `Skipping Shopyy webhook deletion for store ${conn.externalStoreId}: no recorded webhook IDs`,
      );
      return;
    }

    const client = this.shopyyClient(conn.openapiDomain, conn.devToken);
    try {
      await client.batchDeleteWebhooks(conn.webhookIds);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Ignoring Shopyy webhook deletion failure for store ${conn.externalStoreId}: ${reason}`,
      );
    }
  }

  /** PG sent count + ClickHouse engagement for one flow. Best-effort on CH outage. */
  private async automationStats(accountId: string, automationId: string): Promise<FlowStatsView> {
    const [sent, engagement, sales] = await Promise.all([
      this.prisma.shopAutomationSend.count({
        where: { automationId, status: 'sent' },
      }),
      getAutomationEngagement(this.ch.client, { accountId, automationId }).catch(() => ({
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
      })),
      this.flowRevenue(accountId, automationId),
    ]);
    return { sent, ...engagement, ...sales };
  }

  /**
   * Revenue hard-attributed to a flow (orders whose recall link carried this
   * flow's `sm_mid`). Groups by currency and reports the dominant one's sum —
   * single-currency stores are the norm; mixed stores show their top currency.
   */
  private async flowRevenue(
    accountId: string,
    automationId: string,
  ): Promise<{ revenue: number; currency: string }> {
    const rows = await this.prisma.shopOrder.groupBy({
      by: ['currency'],
      where: { accountId, attributedAutomationId: automationId },
      _sum: { value: true },
    });
    if (rows.length === 0) return { revenue: 0, currency: 'USD' };
    rows.sort((a, b) => Number(b._sum.value ?? 0) - Number(a._sum.value ?? 0));
    const top = rows[0]!;
    return { revenue: Number(top._sum.value ?? 0), currency: top.currency };
  }

  /** Verify the store belongs to this tenant; throws 404 otherwise. */
  private async assertConnection(accountId: string, connectionId: string): Promise<ShopConnection> {
    const conn = await this.prisma.shopConnection.findFirst({
      where: { id: connectionId, accountId },
    });
    if (!conn) throw new NotFoundException('店铺连接不存在');
    return conn;
  }

  /**
   * Return the fixed automations for a store, lazily creating any that don't
   * yet exist so the settings UI always renders every supported flow.
   */
  async listAutomations(accountId: string, connectionId: string): Promise<ShopAutomationView[]> {
    await this.assertConnection(accountId, connectionId);
    const { rows, stepsByAutomation } = await this.provisionAutomations(accountId, connectionId);

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

  /**
   * Ensure every fixed flow exists and owns an editable snapshot of the latest
   * system template. Called on bind and remains idempotent for page reads.
   */
  private async provisionAutomations(
    accountId: string,
    connectionId: string,
  ): Promise<{ rows: ShopAutomation[]; stepsByAutomation: ShopAutomationStep[] }> {
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

    // Copy each flow/round's template content inline (once) so the UI can show
    // a thumbnail + open the editor with the existing design.
    await this.materializeContent(rows, stepsByAutomation);

    return { rows, stepsByAutomation };
  }

  /**
   * Make each automation/round self-contained by copying its source template's
   * content inline the first time it's listed (html still null). Mutates the
   * passed rows in place so the freshly-materialised content is returned without
   * a re-read. Idempotent: rows already carrying html are skipped.
   */
  private async materializeContent(
    automations: ShopAutomation[],
    steps: ShopAutomationStep[],
  ): Promise<void> {
    const cache = new Map<
      string,
      {
        html: string;
        mjml: string | null;
        designJson: Prisma.JsonValue;
        thumbnail: string | null;
      } | null
    >();
    const load = async (id: string) => {
      if (cache.has(id)) return cache.get(id)!;
      const t = await this.prisma.emailTemplate.findUnique({
        where: { id },
        select: { html: true, mjml: true, designJson: true, thumbnail: true },
      });
      const v = t?.html
        ? { html: t.html, mjml: t.mjml, designJson: t.designJson, thumbnail: t.thumbnail }
        : null;
      cache.set(id, v);
      return v;
    };
    const json = (v: Prisma.JsonValue): Prisma.InputJsonValue | typeof Prisma.DbNull =>
      v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue);

    for (const a of automations) {
      if (a.html != null) continue;
      const c = await load(a.templateId ?? DEFAULT_TEMPLATE_ID[a.type]);
      if (!c) continue;
      const upd = await this.prisma.shopAutomation.update({
        where: { id: a.id },
        data: {
          html: c.html,
          mjml: c.mjml,
          designJson: json(c.designJson),
          thumbnail: c.thumbnail,
        },
      });
      Object.assign(a, upd);
    }
    for (const s of steps) {
      if (s.html != null) continue;
      const parent = automations.find((a) => a.id === s.automationId);
      const c = await load(
        s.templateId ?? parent?.templateId ?? DEFAULT_TEMPLATE_ID.abandoned_cart,
      );
      if (!c) continue;
      const upd = await this.prisma.shopAutomationStep.update({
        where: { id: s.id },
        data: {
          html: c.html,
          mjml: c.mjml,
          designJson: json(c.designJson),
          thumbnail: c.thumbnail,
        },
      });
      Object.assign(s, upd);
    }
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
    const isCustomerRegistered = type === 'customer_registered';
    const { steps, designJson, couponCode: inputCouponCode, ...rest } = input;
    const couponCode = isCustomerRegistered ? inputCouponCode?.trim() || null : null;
    const couponPatch = {
      couponCode,
      // Only the welcome flow uses a parent-level coupon. Other single-email
      // flows clear these fields so stale values cannot render later.
      couponDiscountKind: couponCode ? (input.couponDiscountKind ?? null) : null,
      couponDiscountValue: couponCode ? (input.couponDiscountValue ?? null) : null,
    };
    const toJson = (v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
      v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue);

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
        html: s.html,
        subject: s.subject,
        delayMinutes: s.delayMinutes,
      }));
    }

    const willBeEnabled = input.enabled ?? existing?.enabled ?? false;

    // Enabling requires a deliverable config: a verified sender + a template
    // (every round for abandoned_cart, the single template otherwise).
    if (willBeEnabled) {
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
      await this.assertTransactionalSender(accountId, fromEmail);
      if (isAbandoned) {
        if (!effectiveSteps?.length || effectiveSteps.some((s) => !(s.html ?? s.templateId))) {
          throw new BadRequestException('启用前请为每一轮设置邮件内容');
        }
      } else if (!(rest.html ?? existing?.html ?? rest.templateId ?? existing?.templateId)) {
        throw new BadRequestException('启用前请先设置邮件内容');
      }
    }

    // For abandoned_cart, mirror round 1 onto the parent so legacy reads and
    // the worker's fallback path keep resolving sensible content/subject.
    const first = isAbandoned ? steps?.[0] : undefined;
    const parentData = first
      ? {
          ...rest,
          templateId: first.templateId ?? null,
          subject: first.subject ?? null,
          delayMinutes: first.delayMinutes,
          html: first.html ?? null,
          mjml: first.mjml ?? null,
          designJson: toJson(first.designJson),
          thumbnail: first.thumbnail ?? null,
          preheader: first.preheader ?? null,
          couponCode: null,
          couponDiscountKind: null,
          couponDiscountValue: null,
        }
      : { ...rest, ...couponPatch, designJson: toJson(designJson) };

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
              html: s.html ?? null,
              mjml: s.mjml ?? null,
              designJson: toJson(s.designJson),
              thumbnail: s.thumbnail ?? null,
              preheader: s.preheader ?? null,
              subject: s.subject ?? null,
              couponCode,
              // Only keep the discount snapshot when a coupon is actually set.
              couponDiscountKind: couponCode ? (s.couponDiscountKind ?? null) : null,
              couponDiscountValue: couponCode ? (s.couponDiscountValue ?? null) : null,
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
    return toAutomationView(updated, stepRows, await this.automationStats(accountId, updated.id));
  }

  private async assertTransactionalSender(accountId: string, fromEmail: string): Promise<void> {
    const domain = fromEmail.split('@')[1]?.toLowerCase();
    if (!domain) throw new BadRequestException(`发件邮箱 ${fromEmail} 格式不正确`);
    const senderDomain = await this.prisma.senderDomain.findFirst({
      where: { accountId, domain, status: 'verified' },
      include: { emailChannel: true },
    });
    if (!senderDomain) throw new BadRequestException(`发件域名 ${domain} 尚未验证`);
    if (senderDomain.emailChannel.status !== 'active') {
      throw new BadRequestException(
        `邮件通道 ${senderDomain.emailChannel.name} 当前状态为 ${senderDomain.emailChannel.status}`,
      );
    }
    const link = await this.prisma.accountEmailChannel.findUnique({
      where: {
        accountId_emailChannelId: {
          accountId,
          emailChannelId: senderDomain.emailChannelId,
        },
      },
      select: { allowTransactional: true },
    });
    if (!link?.allowTransactional) {
      throw new BadRequestException(
        `邮件通道 ${senderDomain.emailChannel.name} 未开启事务场景，不能发送自动化事务邮件`,
      );
    }
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
    const client = this.shopyyClient(conn.openapiDomain, conn.devToken);
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

  /** Live authorization + webhook integrity check for the store settings page. */
  async checkConnectionHealth(
    accountId: string,
    connectionId: string,
  ): Promise<ShopConnectionHealthView> {
    const conn = await this.assertConnection(accountId, connectionId);
    const checkedAt = new Date().toISOString();
    if (conn.status === 'revoked') {
      return {
        status: 'revoked',
        authorizationValid: false,
        expectedWebhookCount: conn.webhookIds.length,
        installedWebhookCount: 0,
        missingWebhookIds: conn.webhookIds,
        checkedAt,
        message: '店铺已解绑',
      };
    }

    try {
      const webhooks = await this.shopyyClient(conn.openapiDomain, conn.devToken).listWebhooks();
      const receiverPrefix = this.shopyyWebhookReceiverUrl();
      const liveIds = new Set(
        webhooks
          .filter(
            (webhook) => typeof webhook.url === 'string' && webhook.url.startsWith(receiverPrefix),
          )
          .map((webhook) => webhook.id),
      );
      const missingWebhookIds = conn.webhookIds.filter((id) => !liveIds.has(id));
      const installedWebhookCount = conn.webhookIds.length - missingWebhookIds.length;
      const healthy = conn.webhookIds.length > 0 && missingWebhookIds.length === 0;
      return {
        status: healthy ? 'healthy' : 'degraded',
        authorizationValid: true,
        expectedWebhookCount: conn.webhookIds.length,
        installedWebhookCount,
        missingWebhookIds,
        checkedAt,
        message: healthy
          ? null
          : conn.webhookIds.length === 0
            ? '未记录该店铺的 Webhook，请执行修复'
            : `有 ${missingWebhookIds.length} 个 Webhook 缺失，请执行修复`,
      };
    } catch (err) {
      const authorizationValid = !(err instanceof ShopyyAuthError);
      if (!authorizationValid && conn.status !== 'expired') {
        await this.prisma.shopConnection.update({
          where: { id: conn.id },
          data: { status: 'expired' },
        });
      }
      return {
        status: authorizationValid ? 'degraded' : 'expired',
        authorizationValid,
        expectedWebhookCount: conn.webhookIds.length,
        installedWebhookCount: 0,
        missingWebhookIds: conn.webhookIds,
        checkedAt,
        message: authorizationValid
          ? `健康检查失败：${err instanceof Error ? err.message : String(err)}`
          : '店铺授权已失效，请重新授权',
      };
    }
  }

  /** Recreate/update the store's owned webhooks and persist their current IDs. */
  async repairWebhooks(accountId: string, connectionId: string): Promise<ShopConnectionHealthView> {
    const conn = await this.assertConnection(accountId, connectionId);
    if (conn.status === 'revoked') throw new BadRequestException('店铺已解绑，请先重新授权');
    if (!conn.appExternalId) throw new BadRequestException('店铺连接缺少 APP_ID，请重新授权店铺');
    const webhookSecret = conn.webhookSecret ?? randomBytes(24).toString('hex');
    let webhookIds: number[];
    try {
      webhookIds = await this.installWebhooks({
        externalStoreId: conn.externalStoreId,
        openapiDomain: conn.openapiDomain,
        devToken: conn.devToken,
        webhookSecret,
        appId: conn.appExternalId,
      });
    } catch (err) {
      if (err instanceof ShopyyAuthError) {
        await this.prisma.shopConnection.update({
          where: { id: conn.id },
          data: { status: 'expired' },
        });
        throw new BadRequestException('店铺授权已失效，请重新授权后再修复 Webhook');
      }
      throw new BadRequestException(
        `修复 Shopyy Webhook 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.prisma.shopConnection.update({
      where: { id: conn.id },
      data: { webhookIds, webhookSecret, status: 'active' },
    });
    return this.checkConnectionHealth(accountId, connectionId);
  }

  /** Tenant-facing history of every automation message, including skipped rows. */
  async listAutomationSends(
    accountId: string,
    query: ShopAutomationSendQuery,
  ): Promise<ShopAutomationSendListResponse> {
    const where: Prisma.ShopAutomationSendWhereInput = { accountId };
    if (query.connectionId || query.automationType) {
      where.automation = {
        ...(query.connectionId ? { shopConnectionId: query.connectionId } : {}),
        ...(query.automationType ? { type: query.automationType as ShopAutomationType } : {}),
      };
    }
    if (query.status) where.status = query.status;
    if (query.email) where.email = { contains: query.email, mode: 'insensitive' };

    const [total, rows] = await Promise.all([
      this.prisma.shopAutomationSend.count({ where }),
      this.prisma.shopAutomationSend.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        include: {
          automation: {
            select: {
              id: true,
              type: true,
              shopConnectionId: true,
              shopConnection: { select: { shopName: true } },
            },
          },
        },
      }),
    ]);

    return {
      total,
      offset: query.offset,
      limit: query.limit,
      rows: rows.map((send) => {
        const mergeVars = send.mergeVars as Record<string, unknown> | null;
        const orderNo = mergeVars?.order_no;
        return {
          id: send.id,
          connectionId: send.automation.shopConnectionId,
          shopName: send.automation.shopConnection.shopName,
          automationId: send.automation.id,
          automationType: send.automation.type as ShopAutomationTypeDto,
          email: send.email,
          subject: send.subject,
          status: send.status,
          errorMessage: send.errorMessage,
          messageId: send.messageId,
          orderNo: typeof orderNo === 'string' ? orderNo : null,
          sentAt: send.sentAt?.toISOString() ?? null,
          createdAt: send.createdAt.toISOString(),
        };
      }),
    };
  }

  async disconnect(accountId: string, id: string): Promise<{ ok: true }> {
    const conn = await this.prisma.shopConnection.findFirst({
      where: { id, accountId },
    });
    if (!conn) throw new NotFoundException('店铺连接不存在');
    await this.uninstallWebhooks(conn);
    // Soft-revoke: keep the row, orders, and automation configuration for
    // history/reconnect, but disable every automation so queued jobs also stop.
    await this.prisma.$transaction([
      this.prisma.shopConnection.update({
        where: { id },
        data: { status: 'revoked', webhookIds: [] },
      }),
      this.prisma.shopAutomation.updateMany({
        where: { shopConnectionId: id, enabled: true },
        data: { enabled: false },
      }),
    ]);
    return { ok: true };
  }
}
