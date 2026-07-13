import { Prisma, type PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';

/**
 * Transactional send mechanism shared by all shopyy automations (Klaviyo-style
 * "flow send").
 *
 * Each triggered email is a first-class `shop_automation_sends` row that is
 * sent and tracked independently — NOT a campaign. worker-sender's runFlowSend
 * picks it off the `send-email` queue, renders the automation's template with
 * the per-send merge vars, and applies the same quota / channel routing / open-
 * click-bounce tracking machinery as campaigns (source='automation').
 */

export interface TransactionalParams {
  accountId: string;
  automationId: string;
  /**
   * Pre-generated send id. Set when the caller embedded it in the email (e.g.
   * the recall CTA's `sm_mid` for order attribution) so the row id matches the
   * link. Omit to let the DB generate one.
   */
  sendId?: string;
  /** Idempotency key (external order/checkout id); blocks duplicate sends. */
  dedupKey: string;
  contactId: string;
  email: string;
  subject: string;
  fromEmail: string;
  fromName: string;
  /**
   * Template this send renders. Snapshots the abandoned-cart round's template
   * (each round can differ); omit to fall back to the automation's template.
   */
  templateId?: string | null;
  /**
   * Inline email content snapshotted at enqueue time (preferred over template).
   * Automations now store their content inline per round/flow.
   */
  html?: string | null;
  /** Inbox preview text (preheader) snapshotted at enqueue time. */
  preheader?: string | null;
  /** Per-send {{order_total}} etc. resolved at send time. */
  mergeVars: Record<string, string>;
}

/** Best-effort currency formatting, e.g. (59, 'USD') -> 'US$59.00'. */
export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/**
 * Resolve the email channel a from-address routes through (its domain must be a
 * verified sender domain on this tenant). NULL = unroutable.
 */
async function resolveEmailChannelId(
  prisma: PrismaClient,
  accountId: string,
  fromEmail: string,
): Promise<{ emailChannelId: string } | { error: string }> {
  const domain = fromEmail.split('@')[1]?.toLowerCase();
  if (!domain) return { error: `发件邮箱 ${fromEmail} 格式不正确` };
  const sd = await prisma.senderDomain.findFirst({
    where: { accountId, domain, status: 'verified' },
    include: { emailChannel: { select: { id: true, name: true, status: true } } },
  });
  if (!sd) return { error: `发件域名 ${domain} 未在本账户验证` };
  if (sd.emailChannel.status !== 'active') {
    return { error: `邮件通道 ${sd.emailChannel.name} 当前状态为 ${sd.emailChannel.status}` };
  }
  const link = await prisma.accountEmailChannel.findUnique({
    where: { accountId_emailChannelId: { accountId, emailChannelId: sd.emailChannelId } },
    select: { allowTransactional: true },
  });
  if (!link?.allowTransactional) {
    return { error: `邮件通道 ${sd.emailChannel.name} 未开启事务场景，不能发送自动化事务邮件` };
  }
  return { emailChannelId: sd.emailChannelId };
}

/**
 * Create + enqueue one flow send. Returns the send id, or null when skipped
 * (already sent for this dedupKey, or unroutable sender). The
 * `(automationId, dedupKey)` unique index makes webhook re-delivery idempotent.
 */
export async function enqueueTransactional(
  deps: { prisma: PrismaClient; sendQueue: Queue },
  params: TransactionalParams,
): Promise<string | null> {
  const { prisma, sendQueue } = deps;

  let sendId: string;
  try {
    const created = await prisma.shopAutomationSend.create({
      data: {
        ...(params.sendId ? { id: params.sendId } : {}),
        accountId: params.accountId,
        automationId: params.automationId,
        dedupKey: params.dedupKey,
        email: params.email,
        contactId: params.contactId,
        templateId: params.templateId ?? null,
        html: params.html ?? null,
        preheader: params.preheader ?? null,
        subject: params.subject,
        fromEmail: params.fromEmail,
        fromName: params.fromName,
        mergeVars: params.mergeVars as Prisma.InputJsonValue,
        status: 'pending',
      },
      select: { id: true },
    });
    sendId = created.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return null;
    }
    throw err;
  }

  const resolved = await resolveEmailChannelId(
    prisma,
    params.accountId,
    params.fromEmail,
  );
  if ('error' in resolved) {
    await prisma.shopAutomationSend.update({
      where: { id: sendId },
      data: {
        status: 'failed',
        errorMessage: resolved.error,
      },
    });
    return null;
  }
  const { emailChannelId } = resolved;

  await prisma.shopAutomationSend.update({
    where: { id: sendId },
    data: { emailChannelId },
  });

  await sendQueue.add(
    'send',
    { flowSendId: sendId, emailChannelId },
    {
      jobId: `f-${sendId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: { age: 86400 * 7 },
    },
  );

  // Mark queued only after Redis accepted the job. updateMany's status guard
  // avoids racing a very fast sender that may already have completed the send.
  await prisma.shopAutomationSend.updateMany({
    where: { id: sendId, status: 'pending' },
    data: { status: 'queued' },
  });

  return sendId;
}
