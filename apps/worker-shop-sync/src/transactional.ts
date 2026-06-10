import { Prisma, type PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';

/**
 * Transactional send mechanism shared by all shopyy automations (Klaviyo-style
 * "flow send").
 *
 * Each triggered email is a first-class `shop_automation_sends` row that is
 * sent and tracked independently — NOT a campaign. worker-sender's runFlowSend
 * picks it off the `send-email` queue, renders the automation's template with
 * the per-send merge vars, and applies the same quota / ACS routing / open-
 * click-bounce tracking machinery as campaigns (source='automation').
 */

export interface TransactionalParams {
  accountId: string;
  automationId: string;
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
 * Resolve the ACS account a from-address routes through (its domain must be a
 * verified sender domain on this tenant). NULL = unroutable.
 */
async function resolveAcsAccountId(
  prisma: PrismaClient,
  accountId: string,
  fromEmail: string,
): Promise<string | null> {
  const domain = fromEmail.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  const sd = await prisma.senderDomain.findFirst({
    where: { accountId, domain },
    select: { acsAccountId: true },
  });
  return sd?.acsAccountId ?? null;
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
        accountId: params.accountId,
        automationId: params.automationId,
        dedupKey: params.dedupKey,
        email: params.email,
        contactId: params.contactId,
        templateId: params.templateId ?? null,
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

  const acsAccountId = await resolveAcsAccountId(
    prisma,
    params.accountId,
    params.fromEmail,
  );
  if (!acsAccountId) {
    await prisma.shopAutomationSend.update({
      where: { id: sendId },
      data: {
        status: 'failed',
        errorMessage: `发件域名 ${params.fromEmail.split('@')[1] ?? ''} 未在本账户验证`,
      },
    });
    return null;
  }

  await prisma.shopAutomationSend.update({
    where: { id: sendId },
    data: { acsAccountId, status: 'queued' },
  });

  await sendQueue.add(
    'send',
    { flowSendId: sendId, acsAccountId },
    { jobId: `f-${sendId}`, removeOnComplete: true, removeOnFail: { age: 86400 * 7 } },
  );

  return sendId;
}
