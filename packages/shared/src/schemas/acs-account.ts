import { z } from 'zod';

export const AcsAccountStatusSchema = z.enum(['active', 'suspended', 'retired']);
export type AcsAccountStatusValue = z.infer<typeof AcsAccountStatusSchema>;

export const CreateAcsAccountSchema = z.object({
  name: z.string().min(1).max(120),
  rpsLimit: z.coerce.number().int().min(1).max(100000),
  rpmLimit: z.coerce.number().int().min(1).max(10000000),
  rphLimit: z.coerce.number().int().min(1).max(100000000),
  rpdLimit: z.coerce.number().int().min(1).max(10000000000),
  status: AcsAccountStatusSchema.optional(),
  // Azure ARM credentials so the API can manage domains under this ACS.
  azureTenantId: z.string().min(1).max(120),
  azureClientId: z.string().min(1).max(120),
  azureClientSecret: z.string().min(1).max(2000),
  azureSubscriptionId: z.string().min(1).max(120),
  azureResourceGroup: z.string().min(1).max(120),
  azureEmailServiceName: z.string().min(1).max(120),
  // Optional for backward-compat with accounts created before this field
  // existed; required at link-domain time, validated in the service layer.
  azureCommunicationServiceName: z.string().min(1).max(120).optional().nullable(),
});
export type CreateAcsAccountInput = z.infer<typeof CreateAcsAccountSchema>;

export const UpdateAcsAccountSchema = CreateAcsAccountSchema.partial();
export type UpdateAcsAccountInput = z.infer<typeof UpdateAcsAccountSchema>;

export interface AcsAccountView {
  id: string;
  name: string;
  rpsLimit: number;
  rpmLimit: number;
  rphLimit: number;
  rpdLimit: number;
  status: AcsAccountStatusValue;
  azureTenantId: string;
  azureClientId: string;
  /** Redacted in list, full in single-get (same convention as connectionString). */
  azureClientSecret: string;
  azureSubscriptionId: string;
  azureResourceGroup: string;
  azureEmailServiceName: string;
  azureCommunicationServiceName: string | null;
  /** Whether this account is the platform-wide default for new signups. */
  isDefault: boolean;
  senderDomainCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Set the full set of ACS accounts a tenant may send through, plus which one is
 * primary. An empty list clears all assignments. `primaryAcsAccountId` must be a
 * member of `acsAccountIds` (or null when the list is empty).
 */
export const AssignAcsAccountsSchema = z
  .object({
    acsAccountIds: z.array(z.string().uuid()).max(50),
    primaryAcsAccountId: z.string().uuid().nullable(),
  })
  .refine(
    (v) =>
      v.acsAccountIds.length === 0
        ? v.primaryAcsAccountId === null
        : v.primaryAcsAccountId !== null && v.acsAccountIds.includes(v.primaryAcsAccountId),
    { message: '主 ACS 账号必须是已分配集合中的一个' },
  );
export type AssignAcsAccountsInput = z.infer<typeof AssignAcsAccountsSchema>;

/** A single ACS assignment for a tenant, as shown in admin/tenant views. */
export interface AssignedAcsAccountView {
  id: string;
  name: string;
  status: AcsAccountStatusValue;
  isPrimary: boolean;
}

export interface AdminAccountView {
  id: string;
  name: string;
  slug: string;
  /** All ACS accounts assigned to this tenant; one has isPrimary=true. */
  acsAccounts: AssignedAcsAccountView[];
  senderDomainCount: number;
  sendQuotaRemaining: number;
  status: 'pending_activation' | 'active' | 'suspended';
  activatedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  /** Owner email — shown in the admin table so the operator knows who they're suspending. */
  ownerEmail: string | null;
  /**
   * Collaborator (trusted partner) account. Normal tenants (false) get the
   * softened analytics view (soft bounces folded into 送达, 弹回邮箱率 hidden);
   * collaborators (true) see the real deliverability data.
   */
  isCollaborator: boolean;
  createdAt: string;
}

/** Toggle a tenant between normal-tenant and collaborator (real-data) view. */
export const SetCollaboratorSchema = z.object({
  isCollaborator: z.boolean(),
});
export type SetCollaboratorInput = z.infer<typeof SetCollaboratorSchema>;

export const SetTenantQuotaSchema = z.object({
  remaining: z.coerce.number().int().min(0).max(2_000_000_000),
});
export type SetTenantQuotaInput = z.infer<typeof SetTenantQuotaSchema>;

export interface TenantQuotaView {
  remaining: number;
}

/**
 * Admin-only state transition. Backend allows:
 *   pending_activation -> active   (admin "manually activate" override)
 *   active             -> suspended
 *   pending_activation -> suspended
 *   suspended          -> active   (unsuspend; back to fully usable)
 *   suspended          -> pending_activation  (force re-verify; rare)
 */
export const SetAccountStatusSchema = z.object({
  status: z.enum(['pending_activation', 'active', 'suspended']),
  /** Optional human-readable reason; required-ish when status=suspended (UI enforces). */
  reason: z.string().trim().max(200).optional(),
});
export type SetAccountStatusInput = z.infer<typeof SetAccountStatusSchema>;
