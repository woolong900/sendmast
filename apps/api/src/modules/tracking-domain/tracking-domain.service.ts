import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QueueService } from '../../common/queue/queue.service';
import type {
  CreateTrackingDomainInput,
  TrackingDomainCheckResult,
  TrackingDomainView,
  UpdateTrackingDomainInput,
} from '@sendmast/shared';
import { QUEUE_NAMES } from '@sendmast/shared';
import { Prisma } from '@sendmast/db';

/**
 * Pool of host names for open/click/unsubscribe URLs. See
 * `model TrackingDomain` in schema.prisma for the rationale.
 *
 * Selection happens in `worker-sender` (per-recipient hash), not here.
 * This service is admin CRUD only.
 */
@Injectable()
export class TrackingDomainService implements OnModuleInit {
  private readonly logger = new Logger(TrackingDomainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queue.createWorker<Record<string, never>>(
      'tracking-domain-health-hourly',
      QUEUE_NAMES.TRACKING_DOMAIN_HEALTH,
      async () => {
        await this.checkAllActive();
      },
      { concurrency: 1 },
    );
    await this.queue.add(
      QUEUE_NAMES.TRACKING_DOMAIN_HEALTH,
      'check-all',
      {},
      {
        jobId: 'tracking-domain-health-hourly',
        repeat: { pattern: '0 * * * *' },
        removeOnComplete: { age: 3600, count: 24 },
        removeOnFail: { age: 86400 * 7 },
      },
    );
  }

  async list(): Promise<TrackingDomainView[]> {
    const rows = await this.prisma.trackingDomain.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toView);
  }

  async create(input: CreateTrackingDomainInput): Promise<TrackingDomainView> {
    // Domain name is normalized (trim+lowercase) by the zod schema before it
    // reaches us, but be defensive: a future caller bypassing the schema
    // shouldn't be able to insert mixed-case duplicates.
    const domain = input.domain.trim().toLowerCase();
    if (!domain) throw new BadRequestException('域名不能为空');
    try {
      const row = await this.prisma.trackingDomain.create({
        data: {
          domain,
          status: 'active',
          notes: input.notes ?? null,
        },
      });
      return toView(row);
    } catch (err) {
      // Unique violation → 409 instead of opaque 500. The unique index is
      // case-sensitive at the DB layer but our normalization above ensures
      // duplicates collide here.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(`域名 ${domain} 已存在`);
      }
      throw err;
    }
  }

  async check(id: string): Promise<TrackingDomainCheckResult> {
    const row = await this.prisma.trackingDomain.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('追踪域名不存在');

    return this.checkAndPersist(row.id, row.domain);
  }

  async checkAllActive(): Promise<{ checked: number; failed: number; disabled: number }> {
    const rows = await this.prisma.trackingDomain.findMany({
      where: { status: 'active' },
      select: { id: true, domain: true },
      orderBy: { domain: 'asc' },
    });
    let failed = 0;
    let disabled = 0;
    for (const row of rows) {
      try {
        const result = await this.checkAndPersist(row.id, row.domain);
        if (!result.ok) failed += 1;
        if (result.disabled) disabled += 1;
      } catch (err) {
        this.logger.error(
          `tracking domain health check failed for ${row.domain}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        failed += 1;
      }
    }
    return { checked: rows.length, failed, disabled };
  }

  async countUsable(): Promise<number> {
    return this.prisma.trackingDomain.count({
      where: {
        status: 'active',
        lastCheckStatus: { in: ['unknown', 'healthy'] },
      },
    });
  }

  private async checkAndPersist(id: string, domain: string): Promise<TrackingDomainCheckResult> {
    const result = await probeTrackingDomain(domain);
    const current = await this.prisma.trackingDomain.findUnique({
      where: { id },
      select: { consecutiveFailures: true },
    });
    if (!current) throw new NotFoundException('追踪域名不存在');
    const consecutiveFailures = result.ok ? 0 : current.consecutiveFailures + 1;
    const disabled = !result.ok && consecutiveFailures >= 3;
    await this.prisma.trackingDomain.update({
      where: { id },
      data: {
        lastCheckStatus: result.ok ? 'healthy' : 'failed',
        lastCheckDnsOk: result.dnsOk,
        lastCheckTlsOk: result.tlsOk,
        lastCheckCaddyOk: result.caddyOk,
        lastCheckHttpStatus: result.status,
        lastCheckLatencyMs: result.latencyMs,
        lastCheckError: result.ok ? null : result.message,
        lastCheckedAt: result.checkedAt,
        consecutiveFailures,
        ...(disabled ? { status: 'disabled' } : {}),
      },
    });
    return {
      ok: result.ok,
      domain,
      url: result.url,
      status: result.status,
      dnsOk: result.dnsOk,
      tlsOk: result.tlsOk,
      caddyOk: result.caddyOk,
      latencyMs: result.latencyMs,
      checkedAt: result.checkedAt.toISOString(),
      consecutiveFailures,
      disabled,
      message: disabled
        ? `${result.message};已连续失败 3 次,系统已自动禁用该域名`
        : result.message,
    };
  }

  async update(
    id: string,
    input: UpdateTrackingDomainInput,
  ): Promise<TrackingDomainView> {
    try {
      const row = await this.prisma.trackingDomain.update({
        where: { id },
        data: {
          ...(input.status !== undefined
            ? {
                status: input.status,
                ...(input.status === 'active'
                  ? {
                      lastCheckStatus: 'unknown',
                      lastCheckDnsOk: null,
                      lastCheckTlsOk: null,
                      lastCheckCaddyOk: null,
                      lastCheckHttpStatus: null,
                      lastCheckLatencyMs: null,
                      lastCheckError: null,
                      lastCheckedAt: null,
                      consecutiveFailures: 0,
                    }
                  : {}),
              }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      return toView(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('追踪域名不存在');
      }
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.trackingDomain.delete({ where: { id } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('追踪域名不存在');
      }
      throw err;
    }
  }
}

async function probeTrackingDomain(domain: string): Promise<{
  ok: boolean;
  domain: string;
  url: string;
  status: number | null;
  dnsOk: boolean;
  tlsOk: boolean;
  caddyOk: boolean;
  latencyMs: number;
  checkedAt: Date;
  message: string;
}> {
  const url = `https://${domain}/t/o/_probe.gif`;
  const started = Date.now();
  const checkedAt = new Date();
  let dnsOk = false;
  try {
    await lookup(domain);
    dnsOk = true;
  } catch (err) {
    return {
      ok: false,
      domain,
      url,
      status: null,
      dnsOk: false,
      tlsOk: false,
      caddyOk: false,
      latencyMs: Date.now() - started,
      checkedAt,
      message: `DNS 解析失败:${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'SendMast tracking-domain-check/1.0',
        accept: 'image/gif,*/*;q=0.8',
      },
    });
    const latencyMs = Date.now() - started;
    const caddyOk = res.status < 500;
    return {
      ok: dnsOk && caddyOk,
      domain,
      url,
      status: res.status,
      dnsOk,
      tlsOk: true,
      caddyOk,
      latencyMs,
      checkedAt,
      message: caddyOk
        ? `DNS 正常,HTTP ${res.status},TLS/Caddy 路由可达`
        : `DNS 正常,HTTP ${res.status},Caddy 或上游服务异常`,
    };
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? '检测超时:10 秒内未收到响应'
        : `TLS/Caddy 检测失败:${err instanceof Error ? err.message : String(err)}`;
    return {
      ok: false,
      domain,
      url,
      status: null,
      dnsOk,
      tlsOk: false,
      caddyOk: false,
      latencyMs: Date.now() - started,
      checkedAt,
      message: msg,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function toView(row: {
  id: string;
  domain: string;
  status: string;
  lastCheckStatus: string;
  lastCheckDnsOk: boolean | null;
  lastCheckTlsOk: boolean | null;
  lastCheckCaddyOk: boolean | null;
  lastCheckHttpStatus: number | null;
  lastCheckLatencyMs: number | null;
  lastCheckError: string | null;
  lastCheckedAt: Date | null;
  consecutiveFailures: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): TrackingDomainView {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    healthStatus:
      row.lastCheckStatus === 'healthy'
        ? 'healthy'
        : row.lastCheckStatus === 'failed'
          ? 'failed'
          : 'unknown',
    dnsOk: row.lastCheckDnsOk,
    tlsOk: row.lastCheckTlsOk,
    caddyOk: row.lastCheckCaddyOk,
    httpStatus: row.lastCheckHttpStatus,
    latencyMs: row.lastCheckLatencyMs,
    lastError: row.lastCheckError,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    consecutiveFailures: row.consecutiveFailures,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
