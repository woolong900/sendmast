import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  CreateCustomTagInput,
  CustomTagView,
  UpdateCustomTagInput,
} from '@sendmast/shared';

function toView(r: {
  id: string;
  name: string;
  values: string[];
  createdAt: Date;
  updatedAt: Date;
}): CustomTagView {
  return {
    id: r.id,
    name: r.name,
    values: r.values,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

@Injectable()
export class CustomTagService {
  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<CustomTagView[]> {
    const rows = await this.prisma.customTag.findMany({
      where: { accountId },
      orderBy: { name: 'asc' },
    });
    return rows.map(toView);
  }

  async get(accountId: string, id: string): Promise<CustomTagView> {
    const row = await this.prisma.customTag.findFirst({
      where: { id, accountId },
    });
    if (!row) throw new NotFoundException('标签不存在');
    return toView(row);
  }

  async create(
    accountId: string,
    input: CreateCustomTagInput,
  ): Promise<CustomTagView> {
    try {
      const row = await this.prisma.customTag.create({
        data: {
          accountId,
          name: input.name.toLowerCase().trim(),
          values: dedupeAndTrim(input.values),
        },
      });
      return toView(row);
    } catch (err) {
      // P2002 = unique constraint violation on (account_id, name).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('已存在同名标签');
      }
      throw err;
    }
  }

  async update(
    accountId: string,
    id: string,
    input: UpdateCustomTagInput,
  ): Promise<CustomTagView> {
    // updateMany so we can scope by accountId in one query (find+update is
    // 2 round trips and races on delete).
    const result = await this.prisma.customTag.updateMany({
      where: { id, accountId },
      data: { values: dedupeAndTrim(input.values) },
    });
    if (result.count === 0) throw new NotFoundException('标签不存在');
    return this.get(accountId, id);
  }

  async remove(accountId: string, id: string): Promise<{ ok: true }> {
    const result = await this.prisma.customTag.deleteMany({
      where: { id, accountId },
    });
    if (result.count === 0) throw new NotFoundException('标签不存在');
    return { ok: true };
  }
}

/**
 * Trim whitespace and drop exact duplicates while preserving order. We keep
 * the user's first occurrence so the editing UI shows the same order they
 * typed; downstream random picker doesn't care about order.
 */
function dedupeAndTrim(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
