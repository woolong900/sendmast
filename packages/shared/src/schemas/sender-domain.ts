import { z } from 'zod';

export const CreateSenderDomainSchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Invalid domain'),
  /**
   * Which ACS account to provision the domain under. Optional: required only
   * when the tenant has more than one assigned ACS account; otherwise the
   * tenant's single (primary) ACS is used. Validated against the tenant's
   * assigned set in the service layer.
   */
  acsAccountId: z.string().uuid().optional(),
});
export type CreateSenderDomainInput = z.infer<typeof CreateSenderDomainSchema>;

/** ACS account a tenant may send through — exposed to tenants for the domain-add picker. */
export interface TenantAcsAccountView {
  id: string;
  name: string;
  isPrimary: boolean;
}

/**
 * One DNS record the customer must add. Names match Azure's
 * `verificationRecords` keys where Azure supplies them (Domain, SPF, DKIM,
 * DKIM2). DMARC is always included — injected by the API with a platform
 * default (`v=DMARC1; p=none`) when Azure omits it.
 */
export type SenderDomainRecordKind = 'Domain' | 'SPF' | 'DKIM' | 'DKIM2' | 'DMARC';

export interface SenderDomainDnsRecord {
  kind: SenderDomainRecordKind;
  type: 'TXT' | 'CNAME';
  /** Host portion the customer should enter in their DNS — e.g. `_dmarc` or `selector1-azurecomm-prod-net._domainkey`. */
  name: string;
  value: string;
  ttl?: number;
}

export type SenderDomainVerificationStatus =
  | 'NotStarted'
  | 'VerificationRequested'
  | 'VerificationFailed'
  | 'Verified'
  | 'CancellationRequested'
  | 'Unknown';

export type SenderDomainVerificationStates = Partial<
  Record<SenderDomainRecordKind, { status: SenderDomainVerificationStatus; lastDetectedAt?: string | null }>
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

export const CreateSenderUsernameSchema = z.object({
  // Local-part of the email; Azure rejects most special chars and uppercase.
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, 'Invalid username'),
  displayName: z.string().max(120).optional(),
});
export type CreateSenderUsernameInput = z.infer<typeof CreateSenderUsernameSchema>;

export interface SenderDomainView {
  id: string;
  domain: string;
  status: SenderDomainStatus;
  acsAccountId: string;
  /** The ACS account this domain is bound to (name shown in the domain list). */
  acsAccount: { id: string; name: string } | null;
  /**
   * DNS records the customer should add. Empty while `status === 'provisioning'`
   * (Azure hasn't returned them yet); populated once provisioning succeeds.
   */
  records: SenderDomainDnsRecord[];
  /** Per-record verification state, populated after the first /verify call. */
  states: SenderDomainVerificationStates;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  /** Set after the domain has been linked to the AcsAccount's CommunicationService. */
  linkedAt: string | null;
  /** Sender usernames that exist on this domain. */
  senderUsernames: SenderUsernameView[];
}
