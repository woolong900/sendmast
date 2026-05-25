import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { FxRateView } from '@sendmast/shared';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=USD&to=CNY';
/** Sanity guard: any rate outside this band almost certainly means the
 *  upstream feed went sideways (decimal point bug, "USD/USD=1" fallback,
 *  etc.). Reject and keep using the previous known rate. Reasonable USD→CNY
 *  has been 6.0–8.0 for the past decade; pad a bit in either direction.
 */
const PLAUSIBLE_RATE_MIN = 4.0;
const PLAUSIBLE_RATE_MAX = 12.0;

/**
 * USD → CNY rate cache. Lazy-pull-on-stale rather than a real cron:
 *   - First call after boot or after 24h fetches Frankfurter, persists a row.
 *   - Subsequent calls within 24h read the cached row.
 *   - `forceRefresh()` lets admins override (button in admin UI).
 *
 * Why no @nestjs/schedule: the lazy strategy hits the same "≤ once / day"
 * SLA without an extra dependency or a cron that fights with multi-replica
 * deploys. The OnModuleInit warm-up populates the row on first boot so the
 * first user doesn't pay the fetch latency.
 */
@Injectable()
export class FxService implements OnModuleInit {
  private readonly logger = new Logger(FxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    // Fire-and-forget warm-up. Network failure here mustn't block API boot.
    this.refresh('frankfurter').catch((err) =>
      this.logger.warn(`FX boot warm-up failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  /** Latest rate, lazy-refreshed if older than 24h. Throws if we have NO
   *  rate at all (first call ever AND Frankfurter is down). */
  async getCurrentRate(base = 'USD', quote = 'CNY'): Promise<FxRateView> {
    const latest = await this.prisma.fxRate.findFirst({
      where: { base, quote },
      orderBy: { fetchedAt: 'desc' },
    });

    const stale =
      !latest || Date.now() - latest.fetchedAt.getTime() > STALE_AFTER_MS;

    if (stale) {
      try {
        return await this.refresh('frankfurter', base, quote);
      } catch (err) {
        // If we have any cached row at all, prefer "slightly stale" over
        // a hard 503 — the alternative is users can't place orders during
        // a Frankfurter outage.
        const msg = err instanceof Error ? err.message : String(err);
        if (latest) {
          this.logger.warn(`FX refresh failed, using stale rate: ${msg}`);
          return this.toView(latest);
        }
        throw new ServiceUnavailableException(`汇率获取失败: ${msg}`);
      }
    }

    return this.toView(latest!);
  }

  /** Force-fetch and persist a fresh rate. Admin-only HTTP wrapper exists
   *  in FxController. */
  async refresh(
    source: 'frankfurter' | 'manual' = 'manual',
    base = 'USD',
    quote = 'CNY',
  ): Promise<FxRateView> {
    const rate = await this.fetchFromFrankfurter(base, quote);
    if (rate < PLAUSIBLE_RATE_MIN || rate > PLAUSIBLE_RATE_MAX) {
      throw new Error(`implausible rate ${rate} (band ${PLAUSIBLE_RATE_MIN}–${PLAUSIBLE_RATE_MAX})`);
    }
    const row = await this.prisma.fxRate.create({
      data: {
        base,
        quote,
        rate,
        source,
        fetchedAt: new Date(),
      },
    });
    this.logger.log(`FX refreshed ${base}→${quote} = ${rate} (${source})`);
    return this.toView(row);
  }

  // ---------- internal --------------------------------------------------

  private async fetchFromFrankfurter(base: string, quote: string): Promise<number> {
    const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { rates?: Record<string, number> };
      const rate = body.rates?.[quote];
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        throw new Error(`bad payload: ${JSON.stringify(body)}`);
      }
      return rate;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toView(r: {
    base: string;
    quote: string;
    rate: { toString(): string } | unknown;
    source: string;
    fetchedAt: Date;
  }): FxRateView {
    return {
      base: r.base,
      quote: r.quote,
      rate: Number((r.rate as { toString(): string }).toString()),
      source: r.source,
      fetchedAt: r.fetchedAt.toISOString(),
    };
  }
}

// Used by FxController — kept here as a constant so admin button copy stays
// in lock-step with the upstream source name.
export const FX_DEFAULT_BASE = 'USD';
export const FX_DEFAULT_QUOTE = 'CNY';
