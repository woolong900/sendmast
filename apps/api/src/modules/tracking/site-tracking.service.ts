import { randomBytes } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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
        siteTrackingKey: true,
        siteTrackingInstall: true,
        siteTrackingLastSeenAt: true,
      },
    });
    if (!conn) throw new NotFoundException('店铺连接不存在');
    let key = conn.siteTrackingKey;
    if (!key) {
      key = `sk_${randomBytes(18).toString('base64url')}`;
      // Conditional write so two concurrent first loads can't hand out
      // different keys; the loser re-reads the winner's key.
      const res = await this.prisma.shopConnection.updateMany({
        where: { id: conn.id, siteTrackingKey: null },
        data: { siteTrackingKey: key, siteTrackingInstall: 'manual' },
      });
      if (res.count === 0) {
        const again = await this.prisma.shopConnection.findUnique({
          where: { id: conn.id },
          select: { siteTrackingKey: true },
        });
        key = again?.siteTrackingKey ?? key;
      }
    }
    return {
      connectionId: conn.id,
      siteKey: key,
      scriptUrl: this.scriptUrl(key),
      snippet: this.snippet(key),
      install: (conn.siteTrackingInstall as 'api' | 'manual' | null) ?? 'manual',
      lastSeenAt: conn.siteTrackingLastSeenAt?.toISOString() ?? null,
      // Flip on once the Shopyy OpenAPI script-injection endpoint is wired up
      // (ShopyyClient + install call at bind time). Until then: manual paste.
      apiInstallSupported: false,
    };
  }
}
