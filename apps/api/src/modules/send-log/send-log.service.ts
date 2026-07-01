import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  SendLogContentView,
  SendLogDetailResponse,
  SendLogListResponse,
  SendLogQuery,
  SendLogView,
} from '@sendmast/shared';

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

  async detail(id: string): Promise<SendLogDetailResponse> {
    const row = await this.prisma.sendLog.findUnique({
      where: { id },
      include: {
        account: { select: { id: true, name: true, slug: true } },
        emailChannel: { select: { id: true, name: true } },
        campaign: { select: { id: true, name: true, subject: true, preheader: true, html: true } },
        automation: {
          select: {
            id: true,
            type: true,
            subject: true,
            preheader: true,
            html: true,
            shopConnection: { select: { shopName: true } },
          },
        },
        automationSend: { select: { subject: true, preheader: true, html: true } },
      },
    });
    if (!row) throw new NotFoundException('发送日志不存在');

    return {
      ...toView(row),
      content: toContent(row),
    };
  }
}

function toContent(r: {
  finalSubject: string | null;
  finalPreheader: string | null;
  finalHtml: string | null;
  campaign: { subject: string; preheader: string | null; html: string | null } | null;
  automation: { subject: string | null; preheader: string | null; html: string | null } | null;
  automationSend: { subject: string | null; preheader: string | null; html: string | null } | null;
}): SendLogContentView {
  if (r.finalHtml || r.finalSubject || r.finalPreheader) {
    return {
      subject: r.finalSubject,
      preheader: r.finalPreheader,
      html: r.finalHtml,
      source: 'send_log',
    };
  }
  if (r.automationSend?.html || r.automationSend?.subject) {
    return {
      subject: r.automationSend.subject,
      preheader: r.automationSend.preheader,
      html: r.automationSend.html,
      source: 'automation_send',
    };
  }
  if (r.automation?.html || r.automation?.subject) {
    return {
      subject: r.automation.subject,
      preheader: r.automation.preheader,
      html: r.automation.html,
      source: 'automation',
    };
  }
  if (r.campaign) {
    return {
      subject: r.campaign.subject,
      preheader: r.campaign.preheader,
      html: r.campaign.html,
      source: 'campaign',
    };
  }
  return { subject: null, preheader: null, html: null, source: null };
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
