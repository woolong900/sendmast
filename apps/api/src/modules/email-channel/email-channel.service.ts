import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  EmailChannelView,
  CreateEmailChannelInput,
  UpdateEmailChannelInput,
} from '@sendmast/shared';

function redact(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 16) return secret.slice(0, 4) + '***';
  return secret.slice(0, 8) + '***' + secret.slice(-4);
}

interface EmailChannelRow {
  id: string;
  provider: string;
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
  mailgunApiKey: string | null;
  mailgunApiBaseUrl: string | null;
  mailgunWebhookSigningKey: string | null;
  resendApiKey: string | null;
  resendApiBaseUrl: string | null;
  resendWebhookSigningKey: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class EmailChannelService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<EmailChannelView[]> {
    const rows = await this.prisma.emailChannel.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { senderDomains: true } } },
    });
    return rows.map((r) => this.toView(r, r._count.senderDomains, true));
  }

  async get(id: string): Promise<EmailChannelView> {
    const row = await this.prisma.emailChannel.findUnique({
      where: { id },
      include: { _count: { select: { senderDomains: true } } },
    });
    if (!row) throw new NotFoundException();
    return this.toView(row, row._count.senderDomains, false);
  }

  async create(input: CreateEmailChannelInput): Promise<EmailChannelView> {
    const row = await this.prisma.emailChannel.create({
      data: {
        name: input.name,
        provider: input.provider,
        rpsLimit: input.rpsLimit,
        rpmLimit: input.rpmLimit,
        rphLimit: input.rphLimit,
        rpdLimit: input.rpdLimit,
        status: input.status ?? 'active',
        azureTenantId: input.azureTenantId ?? '',
        azureClientId: input.azureClientId ?? '',
        azureClientSecret: input.azureClientSecret ?? '',
        azureSubscriptionId: input.azureSubscriptionId ?? '',
        azureResourceGroup: input.azureResourceGroup ?? '',
        azureEmailServiceName: input.azureEmailServiceName ?? '',
        azureCommunicationServiceName: input.azureCommunicationServiceName ?? null,
        mailgunApiKey: input.mailgunApiKey?.trim() || null,
        mailgunApiBaseUrl: input.mailgunApiBaseUrl?.trim() || null,
        mailgunWebhookSigningKey: input.mailgunWebhookSigningKey?.trim() || null,
        resendApiKey: input.resendApiKey?.trim() || null,
        resendApiBaseUrl: input.resendApiBaseUrl?.trim() || null,
        resendWebhookSigningKey: input.resendWebhookSigningKey?.trim() || null,
      },
    });
    return this.toView(row, 0, false);
  }

  async update(id: string, input: UpdateEmailChannelInput): Promise<EmailChannelView> {
    const data: Prisma.EmailChannelUpdateInput = {};
    if (input.provider !== undefined) data.provider = input.provider;
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
    if (input.mailgunApiKey !== undefined)
      data.mailgunApiKey = input.mailgunApiKey?.trim() || null;
    if (input.mailgunApiBaseUrl !== undefined)
      data.mailgunApiBaseUrl = input.mailgunApiBaseUrl?.trim() || null;
    if (input.mailgunWebhookSigningKey !== undefined)
      data.mailgunWebhookSigningKey = input.mailgunWebhookSigningKey?.trim() || null;
    if (input.resendApiKey !== undefined)
      data.resendApiKey = input.resendApiKey?.trim() || null;
    if (input.resendApiBaseUrl !== undefined)
      data.resendApiBaseUrl = input.resendApiBaseUrl?.trim() || null;
    if (input.resendWebhookSigningKey !== undefined)
      data.resendWebhookSigningKey = input.resendWebhookSigningKey?.trim() || null;

    try {
      const row = await this.prisma.emailChannel.update({
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
    const acct = await this.prisma.emailChannel.findUnique({
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
        `无法删除:仍有 ${acct._count.accountLinks} 个租户分配了该邮件通道`,
      );
    }
    await this.prisma.emailChannel.delete({ where: { id } });
  }

  /**
   * Mark a single email channel as the platform-wide default. New tenant
   * signups get a primary AccountEmailChannel link to it. Atomic: clear any
   * previous default first, then promote the target.
   */
  async setDefault(id: string): Promise<EmailChannelView> {
    const target = await this.prisma.emailChannel.findUnique({
      where: { id },
      include: { _count: { select: { senderDomains: true } } },
    });
    if (!target) throw new NotFoundException();
    if (target.status !== 'active') {
      throw new ConflictException('仅 active 状态的邮件通道可设为默认');
    }
    if (target.isDefault) return this.toView(target, target._count.senderDomains, true);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.emailChannel.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      return tx.emailChannel.update({
        where: { id },
        data: { isDefault: true },
        include: { _count: { select: { senderDomains: true } } },
      });
    });
    return this.toView(updated, updated._count.senderDomains, true);
  }

  private toView(row: EmailChannelRow, senderDomainCount: number, redactSecrets: boolean): EmailChannelView {
    return {
      id: row.id,
      provider: row.provider as EmailChannelView['provider'],
      name: row.name,
      rpsLimit: row.rpsLimit,
      rpmLimit: row.rpmLimit,
      rphLimit: row.rphLimit,
      rpdLimit: row.rpdLimit,
      status: row.status as EmailChannelView['status'],
      azureTenantId: row.azureTenantId,
      azureClientId: row.azureClientId,
      azureClientSecret: redactSecrets ? redact(row.azureClientSecret) : row.azureClientSecret,
      azureSubscriptionId: row.azureSubscriptionId,
      azureResourceGroup: row.azureResourceGroup,
      azureEmailServiceName: row.azureEmailServiceName,
      azureCommunicationServiceName: row.azureCommunicationServiceName,
      mailgunApiKey: row.mailgunApiKey
        ? redactSecrets
          ? redact(row.mailgunApiKey)
          : row.mailgunApiKey
        : null,
      mailgunApiBaseUrl: row.mailgunApiBaseUrl,
      mailgunWebhookSigningKey: row.mailgunWebhookSigningKey
        ? redactSecrets
          ? redact(row.mailgunWebhookSigningKey)
          : row.mailgunWebhookSigningKey
        : null,
      resendApiKey: row.resendApiKey
        ? redactSecrets
          ? redact(row.resendApiKey)
          : row.resendApiKey
        : null,
      resendApiBaseUrl: row.resendApiBaseUrl,
      resendWebhookSigningKey: row.resendWebhookSigningKey
        ? redactSecrets
          ? redact(row.resendWebhookSigningKey)
          : row.resendWebhookSigningKey
        : null,
      isDefault: row.isDefault,
      senderDomainCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
