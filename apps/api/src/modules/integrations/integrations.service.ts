import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { ShopAutomation, ShopAutomationType, ShopConnection } from '@prisma/client';
import {
  exchangeAuthorizeToken,
  ShopyyAuthError,
  ShopyyClient,
} from '@sendmast/shopyy';
import {
  SHOP_AUTOMATION_TYPES,
  type ConnectShopyyInput,
  type ShopAutomationType as ShopAutomationTypeDto,
  type ShopAutomationView,
  type ShopConnectionView,
  type UpdateShopAutomationInput,
} from '@sendmast/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Topics we ask shopyy to push. Names are best-effort against the documented
 * conventions; if the real catalogue differs, only this list + the webhook
 * field-mapper need updating — the rest of the pipeline is topic-agnostic.
 */
const SHOPYY_WEBHOOK_TOPICS = ['order.paid', 'order.shipped', 'checkout.abandoned'];

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

function toAutomationView(a: ShopAutomation): ShopAutomationView {
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

    // Best-effort: failing to install push webhooks shouldn't block binding —
    // we can fall back to polling and the operator can re-trigger install.
    await this.installWebhooks(conn).catch((e) =>
      this.logger.warn(
        `Shopyy webhook install failed for store ${externalStoreId}: ${
          e instanceof Error ? e.message : e
        }`,
      ),
    );

    return toView(conn);
  }

  private async installWebhooks(conn: ShopConnection): Promise<void> {
    const rawBase =
      this.config.get<string>('SHOPYY_WEBHOOK_BASE_URL') ??
      `${this.config.getOrThrow<string>('API_BASE_URL')}/api`;
    const base = rawBase.replace(/\/+$/, '');
    // Per-store opaque key authenticates inbound webhooks without depending on
    // shopyy's (undocumented) inbound signing — mirrors the Event Grid ?key=.
    const address =
      `${base}/webhooks/shopyy` +
      `?store=${encodeURIComponent(conn.externalStoreId)}` +
      `&key=${conn.webhookSecret}`;
    const client = new ShopyyClient({
      openapiDomain: conn.openapiDomain,
      token: conn.devToken,
    });
    for (const topic of SHOPYY_WEBHOOK_TOPICS) {
      await client.installWebhook({
        topic,
        address,
        fromId: conn.appExternalId ?? '',
        fromName: conn.appName ?? 'SendMast',
      });
    }
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
        })),
        skipDuplicates: true,
      });
    }
    const rows = await this.prisma.shopAutomation.findMany({
      where: { shopConnectionId: connectionId },
    });
    const order = SHOP_AUTOMATION_TYPES;
    rows.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    return rows.map(toAutomationView);
  }

  async updateAutomation(
    accountId: string,
    connectionId: string,
    type: ShopAutomationTypeDto,
    input: UpdateShopAutomationInput,
  ): Promise<ShopAutomationView> {
    await this.assertConnection(accountId, connectionId);

    // Enabling requires a deliverable config: a template + a verified sender.
    if (input.enabled) {
      const merged = await this.prisma.shopAutomation.findUnique({
        where: {
          shopConnectionId_type: {
            shopConnectionId: connectionId,
            type: type as ShopAutomationType,
          },
        },
      });
      const templateId = input.templateId ?? merged?.templateId;
      const fromEmail = input.fromEmail ?? merged?.fromEmail;
      if (!templateId || !fromEmail) {
        throw new BadRequestException('启用前请先选择邮件模板和发件邮箱');
      }
    }

    const updated = await this.prisma.shopAutomation.upsert({
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
        ...input,
      },
      update: { ...input },
    });
    return toAutomationView(updated);
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
