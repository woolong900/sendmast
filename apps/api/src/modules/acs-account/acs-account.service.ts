import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  AcsAccountView,
  CreateAcsAccountInput,
  UpdateAcsAccountInput,
} from '@sendmast/shared';

function redact(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 16) return secret.slice(0, 4) + '***';
  return secret.slice(0, 8) + '***' + secret.slice(-4);
}

interface AcsRow {
  id: string;
  name: string;
  rpsLimit: number;
  rpmLimit: number;
  rphLimit: number;
  rpdLimit: number;
  status: string;
  azureTenantId: string;
  azureClientId: string;
  azureClientSecret: string;
  azureSubscriptionId: string;
  azureResourceGroup: string;
  azureEmailServiceName: string;
  azureCommunicationServiceName: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class AcsAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AcsAccountView[]> {
    const rows = await this.prisma.acsAccount.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { senderDomains: true } } },
    });
    return rows.map((r) => this.toView(r, r._count.senderDomains, true));
  }

  async get(id: string): Promise<AcsAccountView> {
    const row = await this.prisma.acsAccount.findUnique({
      where: { id },
      include: { _count: { select: { senderDomains: true } } },
    });
    if (!row) throw new NotFoundException();
    return this.toView(row, row._count.senderDomains, false);
  }

  async create(input: CreateAcsAccountInput): Promise<AcsAccountView> {
    const row = await this.prisma.acsAccount.create({
      data: {
        name: input.name,
        rpsLimit: input.rpsLimit,
        rpmLimit: input.rpmLimit,
        rphLimit: input.rphLimit,
        rpdLimit: input.rpdLimit,
        status: input.status ?? 'active',
        azureTenantId: input.azureTenantId,
        azureClientId: input.azureClientId,
        azureClientSecret: input.azureClientSecret,
        azureSubscriptionId: input.azureSubscriptionId,
        azureResourceGroup: input.azureResourceGroup,
        azureEmailServiceName: input.azureEmailServiceName,
        azureCommunicationServiceName: input.azureCommunicationServiceName ?? null,
      },
    });
    return this.toView(row, 0, false);
  }

  async update(id: string, input: UpdateAcsAccountInput): Promise<AcsAccountView> {
    const data: Prisma.AcsAccountUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.rpsLimit !== undefined) data.rpsLimit = input.rpsLimit;
    if (input.rpmLimit !== undefined) data.rpmLimit = input.rpmLimit;
    if (input.rphLimit !== undefined) data.rphLimit = input.rphLimit;
    if (input.rpdLimit !== undefined) data.rpdLimit = input.rpdLimit;
    if (input.status !== undefined) data.status = input.status;
    if (input.azureTenantId !== undefined) data.azureTenantId = input.azureTenantId;
    if (input.azureClientId !== undefined) data.azureClientId = input.azureClientId;
    if (input.azureClientSecret !== undefined) data.azureClientSecret = input.azureClientSecret;
    if (input.azureSubscriptionId !== undefined) data.azureSubscriptionId = input.azureSubscriptionId;
    if (input.azureResourceGroup !== undefined) data.azureResourceGroup = input.azureResourceGroup;
    if (input.azureEmailServiceName !== undefined)
      data.azureEmailServiceName = input.azureEmailServiceName;
    if (input.azureCommunicationServiceName !== undefined)
      data.azureCommunicationServiceName = input.azureCommunicationServiceName ?? null;

    try {
      const row = await this.prisma.acsAccount.update({
        where: { id },
        data,
        include: { _count: { select: { senderDomains: true } } },
      });
      return this.toView(row, row._count.senderDomains, false);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException();
      }
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    const acct = await this.prisma.acsAccount.findUnique({
      where: { id },
      include: {
        _count: { select: { senderDomains: true, accountLinks: true } },
      },
    });
    if (!acct) throw new NotFoundException();
    if (acct._count.senderDomains > 0) {
      throw new ConflictException(
        `Cannot delete: ${acct._count.senderDomains} sender domain(s) still bound`,
      );
    }
    if (acct._count.accountLinks > 0) {
      throw new ConflictException(
        `无法删除:仍有 ${acct._count.accountLinks} 个租户分配了该 ACS 账号`,
      );
    }
    await this.prisma.acsAccount.delete({ where: { id } });
  }

  /**
   * Mark a single ACS account as the platform-wide default. New tenant
   * signups get a primary AccountAcsAccount link to it. Atomic: clear any
   * previous default first, then promote the target.
   */
  async setDefault(id: string): Promise<AcsAccountView> {
    const target = await this.prisma.acsAccount.findUnique({
      where: { id },
      include: { _count: { select: { senderDomains: true } } },
    });
    if (!target) throw new NotFoundException();
    if (target.status !== 'active') {
      throw new ConflictException('仅 active 状态的 ACS 账号可设为默认');
    }
    if (target.isDefault) return this.toView(target, target._count.senderDomains, true);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.acsAccount.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      return tx.acsAccount.update({
        where: { id },
        data: { isDefault: true },
        include: { _count: { select: { senderDomains: true } } },
      });
    });
    return this.toView(updated, updated._count.senderDomains, true);
  }

  private toView(row: AcsRow, senderDomainCount: number, redactSecrets: boolean): AcsAccountView {
    return {
      id: row.id,
      name: row.name,
      rpsLimit: row.rpsLimit,
      rpmLimit: row.rpmLimit,
      rphLimit: row.rphLimit,
      rpdLimit: row.rpdLimit,
      status: row.status as AcsAccountView['status'],
      azureTenantId: row.azureTenantId,
      azureClientId: row.azureClientId,
      azureClientSecret: redactSecrets ? redact(row.azureClientSecret) : row.azureClientSecret,
      azureSubscriptionId: row.azureSubscriptionId,
      azureResourceGroup: row.azureResourceGroup,
      azureEmailServiceName: row.azureEmailServiceName,
      azureCommunicationServiceName: row.azureCommunicationServiceName,
      isDefault: row.isDefault,
      senderDomainCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
