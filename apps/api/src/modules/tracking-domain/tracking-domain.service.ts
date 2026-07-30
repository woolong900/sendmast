import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  CreateTrackingDomainInput,
  TrackingDomainCheckResult,
  TrackingDomainView,
  UpdateTrackingDomainInput,
} from '@sendmast/shared';
import { Prisma } from '@sendmast/db';

/**
 * Pool of host names for open/click/unsubscribe URLs. See
 * `model TrackingDomain` in schema.prisma for the rationale.
 *
 * Selection happens in `worker-sender` (per-recipient hash), not here.
 * This service is admin CRUD only.
 */
@Injectable()
export class TrackingDomainService {
  constructor(private readonly prisma: PrismaService) {}

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

    const domain = row.domain;
    const url = `https://${domain}/t/o/_probe.gif`;
    const started = Date.now();
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
      const ok = res.status < 500;
      return {
        ok,
        domain,
        url,
        status: res.status,
        latencyMs,
        checkedAt: new Date().toISOString(),
        message: ok
          ? `HTTP ${res.status}, TLS/Caddy 路由可达`
          : `HTTP ${res.status}, Cloudflare 或源站可能异常`,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? '检测超时:10 秒内未收到响应'
          : `检测失败:${err instanceof Error ? err.message : String(err)}`;
      return {
        ok: false,
        domain,
        url,
        status: null,
        latencyMs,
        checkedAt: new Date().toISOString(),
        message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async update(
    id: string,
    input: UpdateTrackingDomainInput,
  ): Promise<TrackingDomainView> {
    try {
      const row = await this.prisma.trackingDomain.update({
        where: { id },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
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

function toView(row: {
  id: string;
  domain: string;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): TrackingDomainView {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
