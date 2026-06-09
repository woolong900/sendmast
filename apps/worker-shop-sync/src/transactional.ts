import { Prisma, type PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';

/**
 * Transactional send mechanism shared by all shopyy automations.
 *
 * Each triggered email is materialised as a hidden single-recipient campaign
 * (`isAutomation = true`) plus one `campaign_recipients` row, then pushed
 * straight onto the `send-email` queue. This reuses worker-sender's `runSend`
 * verbatim — tenant quota reservation, ACS routing, click/open tracking,
 * operation-id idempotency and bounce accounting all apply unchanged. A
 * per-send campaign (rather than one shared campaign per automation) keeps the
 * existing `@@unique([campaignId, contactId])` invariant intact so a repeat
 * customer's second order still gets its own email.
 */

export interface TransactionalParams {
  accountId: string;
  automationId: string;
  /** Idempotency key (external order/checkout id); blocks duplicate sends. */
  dedupKey: string;
  contactId: string;
  email: string;
  /** Internal campaign name (never shown to the buyer). */
  name: string;
  subject: string;
  html: string;
  fromEmail: string;
  fromName: string;
  /** Per-recipient {{order_total}} etc. resolved at send time. */
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
 * verified sender domain on this tenant). NULL = unroutable; caller records a
 * failed send so the operator can fix the sender config.
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
 * Enqueue one transactional email. Returns the created recipient id, or null
 * when skipped (already sent for this dedupKey, or unroutable sender). Safe to
 * call from a webhook-driven path: the `ShopAutomationSend` unique index makes
 * re-delivery idempotent.
 */
export async function enqueueTransactional(
  deps: { prisma: PrismaClient; sendQueue: Queue },
  params: TransactionalParams,
): Promise<string | null> {
  const { prisma, sendQueue } = deps;

  // Reserve the dedup slot first so a re-delivered webhook can't create a
  // second campaign before the first finishes. Unique violation = already done.
  try {
    await prisma.shopAutomationSend.create({
      data: {
        accountId: params.accountId,
        automationId: params.automationId,
        dedupKey: params.dedupKey,
        email: params.email,
        contactId: params.contactId,
        status: 'pending',
      },
    });
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
    await prisma.shopAutomationSend.updateMany({
      where: { automationId: params.automationId, dedupKey: params.dedupKey },
      data: {
        status: 'failed',
        errorMessage: `发件域名 ${params.fromEmail.split('@')[1] ?? ''} 未在本账户验证`,
      },
    });
    return null;
  }

  const campaign = await prisma.campaign.create({
    data: {
      accountId: params.accountId,
      name: params.name,
      subject: params.subject,
      fromName: params.fromName,
      fromEmail: params.fromEmail,
      html: params.html,
      editorMode: 'html',
      status: 'draft',
      isAutomation: true,
      totalRecipients: 1,
      utmEnabled: false,
    },
    select: { id: true },
  });

  const recipient = await prisma.campaignRecipient.create({
    data: {
      accountId: params.accountId,
      campaignId: campaign.id,
      contactId: params.contactId,
      email: params.email,
      status: 'queued',
      fromEmail: params.fromEmail,
      fromName: params.fromName,
      acsAccountId,
      mergeVars: params.mergeVars as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  await prisma.shopAutomationSend.updateMany({
    where: { automationId: params.automationId, dedupKey: params.dedupKey },
    data: { status: 'sent', recipientId: recipient.id },
  });

  await sendQueue.add(
    'send',
    { recipientId: recipient.id, acsAccountId },
    { jobId: `r-${recipient.id}`, removeOnComplete: true, removeOnFail: { age: 86400 * 7 } },
  );

  return recipient.id;
}
