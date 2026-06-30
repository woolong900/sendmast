import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { SendLogListResponse, SendLogQuery, SendLogView } from '@sendmast/shared';

@Injectable()
export class SendLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: SendLogQuery): Promise<SendLogListResponse> {
    const where: Prisma.SendLogWhereInput = {};

    if (query.accountId) where.accountId = query.accountId;
    if (query.emailChannelId) where.emailChannelId = query.emailChannelId;
    if (query.source) where.source = query.source;
    if (typeof query.ok === 'boolean') where.ok = query.ok;
    if (query.domain) {
      // Match the trailing `@<domain>` portion of from_address. The domain
      // value comes from a free-text input, so anchor with `@` to avoid
      // matching a substring that just happens to appear in a long address.
      where.fromAddress = { endsWith: `@${query.domain.toLowerCase()}` };
    }
    if (query.from || query.to) {
      where.sentAt = {};
      if (query.from) where.sentAt.gte = new Date(query.from);
      if (query.to) where.sentAt.lte = new Date(query.to);
    }

    // Run count + page in parallel — both hit the same indexes when filtered.
    const [total, rows] = await Promise.all([
      this.prisma.sendLog.count({ where }),
      this.prisma.sendLog.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        include: {
          account: { select: { id: true, name: true, slug: true } },
          emailChannel: { select: { id: true, name: true } },
          campaign: { select: { id: true, name: true } },
          automation: {
            select: {
              id: true,
              type: true,
              shopConnection: { select: { shopName: true } },
            },
          },
        },
      }),
    ]);

    return {
      total,
      offset: query.offset,
      limit: query.limit,
      rows: rows.map(toView),
    };
  }
}

function toView(r: {
  id: string;
  sentAt: Date;
  recipientId: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  ok: boolean;
  providerStatus: string | null;
  messageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  responsePayload: Prisma.JsonValue | null;
  source: string;
  automationSendId: string | null;
  account: { id: string; name: string; slug: string };
  emailChannel: { id: string; name: string } | null;
  campaign: { id: string; name: string } | null;
  automation: { id: string; type: string; shopConnection: { shopName: string | null } } | null;
}): SendLogView {
  return {
    id: r.id,
    sentAt: r.sentAt.toISOString(),
    account: r.account,
    emailChannel: r.emailChannel,
    campaign: r.campaign,
    source: r.source as SendLogView['source'],
    automation: r.automation
      ? {
          id: r.automation.id,
          type: r.automation.type,
          shopName: r.automation.shopConnection.shopName,
        }
      : null,
    recipientId: r.recipientId,
    automationSendId: r.automationSendId,
    fromAddress: r.fromAddress,
    fromName: r.fromName,
    toAddress: r.toAddress,
    ok: r.ok,
    providerStatus: r.providerStatus,
    messageId: r.messageId,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    latencyMs: r.latencyMs,
    responsePayload: r.responsePayload,
  };
}
