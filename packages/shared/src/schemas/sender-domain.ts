import { z } from 'zod';

export function normalizeSenderDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

const DomainName = z
  .string()
  .transform(normalizeSenderDomain)
  .pipe(
    z
      .string()
      .min(3)
      .max(253)
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Invalid domain'),
  );

export const CreateSenderDomainSchema = z.object({
  domain: DomainName,
  /**
   * Which email channel to provision the domain under. Optional: required only
   * when the tenant has more than one assigned email channel; otherwise the
   * tenant's single (primary) email channel is used. Validated against the tenant's
   * assigned set in the service layer.
   */
  emailChannelId: z.string().uuid().optional(),
});
export type CreateSenderDomainInput = z.infer<typeof CreateSenderDomainSchema>;

/** email channel a tenant may send through — exposed to tenants for the domain-add picker. */
export interface TenantEmailChannelView {
  id: string;
  name: string;
  provider: 'acs' | 'mailgun' | 'resend' | 'cloudflare' | 'sendgrid' | 'ses';
  isPrimary: boolean;
  allowMarketing: boolean;
  allowTransactional: boolean;
}

/**
 * One DNS record the customer must add. Names match Azure's
 * `verificationRecords` keys where Azure supplies them (Domain, SPF, DKIM,
 * DKIM2). DMARC is always included — injected by the API with a platform
 * default (`v=DMARC1; p=none`) when Azure omits it.
 */
export type SenderDomainRecordKind =
  | 'Domain'
  | 'SPF'
  | 'DKIM'
  | 'DKIM2'
  | 'DKIM3'
  | 'DMARC'
  | 'Tracking';

export interface SenderDomainDnsRecord {
  kind: SenderDomainRecordKind;
  type: 'TXT' | 'CNAME' | 'MX';
  /** Host portion the customer should enter in their DNS — e.g. `_dmarc` or `selector1-azurecomm-prod-net._domainkey`. */
  name: string;
  value: string;
  ttl?: number;
  priority?: number;
}

export type SenderDomainVerificationStatus =
  | 'NotStarted'
  | 'VerificationRequested'
  | 'VerificationFailed'
  | 'Verified'
  | 'CancellationRequested'
  | 'Unknown';

export type SenderDomainVerificationStates = Partial<
  Record<
    SenderDomainRecordKind,
    { status: SenderDomainVerificationStatus; lastDetectedAt?: string | null }
  >
>;

export type SenderDomainStatus = 'provisioning' | 'pending' | 'verified' | 'failed';

export interface SenderUsernameView {
  id: string;
  username: string;
  displayName: string | null;
  /** Convenience: `${username}@${senderDomain.domain}`. */
  fullAddress: string;
  createdAt: string;
}

/**
 * Display names that pass a message off as coming from a postal/courier
 * service, a tax/customs/benefits agency or similar third party are refused:
 * mail "from" them is indistinguishable from phishing. Not exhaustive —
 * a guard against obvious misuse and copy-pasted test values.
 */
const IMPERSONATION_RE =
  /(u\.?\s?s\.?\s?postal|\busps\b|postal\s+service|post\s+office|royal\s+mail|canada\s+post|australia\s+post|\bfedex\b|\bdhl\b|\birs\b|internal\s+revenue|social\s+security|\bcustoms\b|邮政|海关|税务局|社保)/i;

// "UPS" only as the all-caps carrier name, so "Ups and Downs" stays allowed.
const UPS_RE = /\bUPS\b/;

export function isImpersonatingDisplayName(name: string): boolean {
  return IMPERSONATION_RE.test(name) || UPS_RE.test(name);
}

/** Sender display name shown in the recipient's inbox. */
export const SenderDisplayNameSchema = z.string().trim().max(120);

export const CreateSenderUsernameSchema = z.object({
  // Local-part of the email; Azure rejects most special chars and uppercase.
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, 'Invalid username'),
  displayName: SenderDisplayNameSchema.optional(),
});
export type CreateSenderUsernameInput = z.infer<typeof CreateSenderUsernameSchema>;

/** Change a sender address's display name (synced to the provider). Empty = none. */
export const UpdateSenderUsernameSchema = z.object({
  displayName: SenderDisplayNameSchema,
});
export type UpdateSenderUsernameInput = z.infer<typeof UpdateSenderUsernameSchema>;

export interface SenderDomainView {
  id: string;
  domain: string;
  status: SenderDomainStatus;
  /** Provider-side error captured when async domain provisioning fails. */
  provisioningError: string | null;
  emailChannelId: string;
  /** The sending channel this domain is bound to (name shown in the domain list). */
  emailChannel: {
    id: string;
    name: string;
    provider?: 'acs' | 'mailgun' | 'resend' | 'cloudflare' | 'sendgrid' | 'ses';
    allowMarketing?: boolean;
    allowTransactional?: boolean;
  } | null;
  /**
   * DNS records the customer should add. Empty while `status === 'provisioning'`
   * (Azure hasn't returned them yet); populated once provisioning succeeds.
   */
  records: SenderDomainDnsRecord[];
  /** Per-record verification state, populated after the first /verify call. */
  states: SenderDomainVerificationStates;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  /** Set after the domain has been linked to the EmailChannel's CommunicationService. */
  linkedAt: string | null;
  /** Sender usernames that exist on this domain. */
  senderUsernames: SenderUsernameView[];
}
