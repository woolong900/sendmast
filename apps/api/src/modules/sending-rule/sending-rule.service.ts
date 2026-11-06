import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateSendingRuleInput, SendingRuleView } from '@sendmast/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

type RuleRow = {
  id: string;
  mode: 'allow' | 'block';
  senderDomainPattern: string;
  recipientPattern: string;
  createdAt: Date;
  updatedAt: Date;
};

function toView(row: RuleRow): SendingRuleView {
  return {
    id: row.id,
    mode: row.mode,
    senderDomainPattern: row.senderDomainPattern,
    recipientPattern: row.recipientPattern,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class SendingRuleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<SendingRuleView[]> {
    const rows = await this.prisma.sendingRule.findMany({
      where: { accountId },
      orderBy: [{ senderDomainPattern: 'asc' }, { mode: 'asc' }, { recipientPattern: 'asc' }],
    });
    return rows.map(toView);
  }

  async create(accountId: string, input: CreateSendingRuleInput): Promise<SendingRuleView> {
    try {
      const row = await this.prisma.sendingRule.create({
        data: { accountId, ...input },
      });
      return toView(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('相同的发送规则已存在');
      }
      throw error;
    }
  }

  async remove(accountId: string, id: string): Promise<{ ok: true }> {
    const result = await this.prisma.sendingRule.deleteMany({ where: { id, accountId } });
    if (result.count === 0) throw new NotFoundException('发送规则不存在');
    return { ok: true };
  }
}
