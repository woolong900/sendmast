import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  CreateTrackingDomainInput,
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
