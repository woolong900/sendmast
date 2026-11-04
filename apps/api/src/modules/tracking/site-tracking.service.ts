import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ShopyyAuthError, ShopyyClient, ShopyyError } from '@sendmast/shopyy';
import { ConfigService } from '@nestjs/config';
import {
  QUEUE_NAMES,
  SiteEventBatchSchema,
  type SiteEventsJobData,
  type SiteTrackingStatus,
} from '@sendmast/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../../common/queue/queue.service';
import { buildStorefrontScript } from './storefront-script';

interface SiteKeyEntry {
  shopId: string;
  accountId: string;
  loadedAt: number;
}

const KEY_CACHE_TTL_MS = 60_000;
const KEY_CACHE_MAX = 5000;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;
/** Client clocks are untrusted: accept event timestamps within this window. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000;
/** Name of our loader in the store's custom scripts (also the dedupe key). */
export const SHOPYY_SCRIPT_NAME = 'sendmast_site_tracking';

/**
 * Storefront (landing-page) behaviour tracking: serves the embed script,
 * accepts beacons and hands them to worker-events, and manages per-store
 * install state.
 */
@Injectable()
export class SiteTrackingService {
  private readonly logger = new Logger(SiteTrackingService.name);
  private readonly keyCache = new Map<string, SiteKeyEntry | null>();
  private readonly keyCacheAt = new Map<string, number>();
  private readonly lastSeenWrite = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly config: ConfigService,
  ) {}

  /** Public origin hosting /t/s/* (the app domain; Caddy proxies /t/* to the API). */
  private origin(): string {
    return this.config.getOrThrow<string>('WEB_BASE_URL').replace(/\/+$/, '');
  }

  scriptUrl(key: string): string {
    return `${this.origin()}/t/s/sdk.js?k=${encodeURIComponent(key)}`;
  }

  snippet(key: string): string {
    return `<script async src="${this.scriptUrl(key)}"></script>`;
  }

  renderScript(key: string): string {
    return buildStorefrontScript({ endpoint: `${this.origin()}/t/s/e`, key });
  }

  /** siteKey → active shop connection (cached; negative results cached too). */
  async resolveKey(key: string): Promise<SiteKeyEntry | null> {
    const now = Date.now();
    const at = this.keyCacheAt.get(key);
    if (at !== undefined && now - at < KEY_CACHE_TTL_MS) return this.keyCache.get(key) ?? null;
    const conn = await this.prisma.shopConnection.findUnique({
      where: { siteTrackingKey: key },
      select: { id: true, accountId: true, status: true },
    });
    const entry =
      conn && conn.status === 'active'
        ? { shopId: conn.id, accountId: conn.accountId, loadedAt: now }
        : null;
    if (this.keyCache.size >= KEY_CACHE_MAX) {
      this.keyCache.clear();
      this.keyCacheAt.clear();
    }
    this.keyCache.set(key, entry);
    this.keyCacheAt.set(key, now);
    return entry;
  }

  /**
   * Accept one beacon body. Silently drops anything malformed or for an
   * unknown key — the endpoint always answers 204 so it can't be used to
   * probe keys / recipient ids, and a broken beacon never errors the page.
   */
  async ingest(rawBody: unknown, ip?: string, userAgent?: string): Promise<void> {
    let parsed: unknown = rawBody;
    if (typeof rawBody === 'string') {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return;
      }
    }
    const r = SiteEventBatchSchema.safeParse(parsed);
    if (!r.success) return;
    const site = await this.resolveKey(r.data.k);
    if (!site) return;

    const now = Date.now();
    const events = r.data.e.map((e) => ({
      ...e,
      ts: e.ts && Math.abs(e.ts - now) <= MAX_CLOCK_SKEW_MS ? e.ts : now,
    }));
    const job: SiteEventsJobData = {
      shopId: site.shopId,
      accountId: site.accountId,
      mid: r.data.mid,
      sid: r.data.sid,
      ip,
      userAgent: userAgent?.slice(0, 500),
      receivedAt: now,
      events,
      origin: 'script',
    };
    await this.queue.add(QUEUE_NAMES.SITE_EVENTS_INGEST, 'batch', job, {
      attempts: 3,
      removeOnComplete: true,
      removeOnFail: { age: 86400 },
    });
    await this.touchLastSeen(site.shopId, now);
  }

  private async touchLastSeen(shopId: string, now: number): Promise<void> {
    const last = this.lastSeenWrite.get(shopId) ?? 0;
    if (now - last < LAST_SEEN_WRITE_INTERVAL_MS) return;
    this.lastSeenWrite.set(shopId, now);
    try {
      await this.prisma.shopConnection.update({
        where: { id: shopId },
        data: { siteTrackingLastSeenAt: new Date(now) },
      });
    } catch (err) {
      this.logger.warn(`failed to update site tracking last-seen for ${shopId}: ${String(err)}`);
    }
  }

  /** Install info for a store; generates the site key on first access. */
  async getStatus(accountId: string, connectionId: string): Promise<SiteTrackingStatus> {
    const conn = await this.prisma.shopConnection.findFirst({
      where: { id: connectionId, accountId },
      select: {
        id: true,
        siteTrackingInstall: true,
        siteTrackingLastSeenAt: true,
      },
    });
    if (!conn) throw new NotFoundException('店铺连接不存在');
    const key = await this.ensureKey(conn.id);
    return {
      connectionId: conn.id,
      siteKey: key,
      scriptUrl: this.scriptUrl(key),
      snippet: this.snippet(key),
      install: (conn.siteTrackingInstall as 'api' | 'manual' | null) ?? null,
      lastSeenAt: conn.siteTrackingLastSeenAt?.toISOString() ?? null,
      apiInstallSupported: true,
    };
  }

  /** The connection's site key, generated on first use. */
  private async ensureKey(connectionId: string): Promise<string> {
    const conn = await this.prisma.shopConnection.findUnique({
      where: { id: connectionId },
      select: { siteTrackingKey: true },
    });
    if (conn?.siteTrackingKey) return conn.siteTrackingKey;
    const key = `sk_${randomBytes(18).toString('base64url')}`;
    // Conditional write so two concurrent first loads can't hand out
    // different keys; the loser re-reads the winner's key.
    const res = await this.prisma.shopConnection.updateMany({
      where: { id: connectionId, siteTrackingKey: null },
      data: { siteTrackingKey: key },
    });
    if (res.count > 0) return key;
    const again = await this.prisma.shopConnection.findUnique({
      where: { id: connectionId },
      select: { siteTrackingKey: true },
    });
    return again?.siteTrackingKey ?? key;
  }

  /**
   * `detail` for POST /scripts/batchsave. The docs say the content is
   * "usually wrapped in <script>…</script>" (HTML injected into the page),
   * while their examples show bare JS. Default to the HTML tag form — if the
   * platform treats it as JS it fails silently in the console instead of
   * printing text on the storefront — and allow switching per deployment.
   */
  private loaderDetail(key: string): string {
    const src = this.scriptUrl(key);
    if (process.env.SHOPYY_SCRIPT_DETAIL_FORMAT === 'js') {
      return (
        `(function(){var s=document.createElement('script');s.async=true;` +
        `s.src=${JSON.stringify(src)};document.head.appendChild(s);})();`
      );
    }
    return `<script async src="${src}"></script>`;
  }

  /**
   * Install (or re-install) the loader into the store through the Shopyy
   * OpenAPI custom-script endpoint. Loads on every page incl. checkout.
   * batchsave doesn't return the new id, so we try to recover it from the
   * (undocumented) list endpoint to update instead of duplicate next time.
   * A duplicate would still be harmless — the script guards against running
   * twice on a page.
   */
  async installViaApi(
    accountId: string,
    connectionId: string,
    opts: { onlyIfNotInstalled?: boolean } = {},
  ): Promise<SiteTrackingStatus> {
    const conn = await this.prisma.shopConnection.findFirst({
      where: { id: connectionId, accountId },
      select: {
        id: true,
        status: true,
        openapiDomain: true,
        devToken: true,
        siteTrackingInstall: true,
        siteTrackingScriptId: true,
      },
    });
    if (!conn) throw new NotFoundException('店铺连接不存在');
    if (conn.status !== 'active') throw new BadRequestException('店铺连接已失效,请重新授权');
    if (
      opts.onlyIfNotInstalled &&
      conn.siteTrackingInstall === 'api' &&
      conn.siteTrackingScriptId
    ) {
      return this.getStatus(accountId, connectionId);
    }

    const key = await this.ensureKey(conn.id);
    const client = new ShopyyClient({
      openapiDomain: conn.openapiDomain,
      token: conn.devToken,
      partnerId: this.config.get<string>('SHOPYY_PARTNER_ID'),
    });

    let scriptId = conn.siteTrackingScriptId ?? (await this.findScriptId(client));
    try {
      await client.batchSaveScripts([
        {
          ...(scriptId != null ? { id: scriptId } : {}),
          scriptName: SHOPYY_SCRIPT_NAME,
          displayRoutes: 'all',
          displayCheckout: true,
          detail: this.loaderDetail(key),
          enabled: true,
        },
      ]);
    } catch (err) {
      throw new BadRequestException(this.describeShopyyError(err));
    }
    scriptId = scriptId ?? (await this.findScriptId(client));

    await this.prisma.shopConnection.update({
      where: { id: conn.id },
      data: { siteTrackingInstall: 'api', siteTrackingScriptId: scriptId ?? null },
    });
    return this.getStatus(accountId, connectionId);
  }

  /** Disable our loader in the store (on disconnect). Best-effort. */
  async disableViaApi(connectionId: string): Promise<void> {
    const conn = await this.prisma.shopConnection.findUnique({
      where: { id: connectionId },
      select: {
        openapiDomain: true,
        devToken: true,
        siteTrackingKey: true,
        siteTrackingScriptId: true,
      },
    });
    if (!conn?.siteTrackingScriptId || !conn.siteTrackingKey) return;
    try {
      const client = new ShopyyClient({
        openapiDomain: conn.openapiDomain,
        token: conn.devToken,
        partnerId: this.config.get<string>('SHOPYY_PARTNER_ID'),
      });
      await client.batchSaveScripts([
        {
          id: conn.siteTrackingScriptId,
          scriptName: SHOPYY_SCRIPT_NAME,
          displayRoutes: 'all',
          displayCheckout: true,
          detail: this.loaderDetail(conn.siteTrackingKey),
          enabled: false,
        },
      ]);
    } catch (err) {
      // The script serves a no-op for revoked stores anyway.
      this.logger.warn(`disable storefront script for ${connectionId} failed: ${String(err)}`);
    }
  }

  private async findScriptId(client: ShopyyClient): Promise<number | null> {
    try {
      const rows = await client.listScripts();
      const mine = rows.find((r) => r.script_name === SHOPYY_SCRIPT_NAME && r.id != null);
      return mine?.id ?? null;
    } catch {
      return null; // list endpoint unavailable — fall back to create
    }
  }

  private describeShopyyError(err: unknown): string {
    if (err instanceof ShopyyError && (err.code === 401 || err instanceof ShopyyAuthError)) {
      return '店铺应用没有「自定义脚本」接口权限(或授权已失效),请在 Shopyy 开发者后台为应用开通脚本权限后重新授权,或复制下方代码手动安装。';
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `自动安装失败:${msg}。可复制下方代码手动安装。`;
  }
}
