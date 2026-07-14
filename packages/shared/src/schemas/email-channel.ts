import { z } from 'zod';

export const EmailChannelStatusSchema = z.enum(['active', 'suspended', 'retired']);
export type EmailChannelStatusValue = z.infer<typeof EmailChannelStatusSchema>;
export const EmailChannelProviderSchema = z.enum(['acs', 'mailgun', 'resend']);
export type EmailChannelProviderValue = z.infer<typeof EmailChannelProviderSchema>;

const EmailChannelBaseSchema = z.object({
  provider: EmailChannelProviderSchema.default('acs'),
  name: z.string().min(1).max(120),
  rpsLimit: z.coerce.number().int().min(1).max(100000),
  rpmLimit: z.coerce.number().int().min(1).max(10000000),
  rphLimit: z.coerce.number().int().min(1).max(100000000),
  rpdLimit: z.coerce.number().int().min(1).max(10000000000),
  status: EmailChannelStatusSchema.optional(),
  // Azure ARM credentials so the API can manage domains under this channel.
  azureTenantId: z.string().max(120).optional().default(''),
  azureClientId: z.string().max(120).optional().default(''),
  azureClientSecret: z.string().max(2000).optional().default(''),
  azureSubscriptionId: z.string().max(120).optional().default(''),
  azureResourceGroup: z.string().max(120).optional().default(''),
  azureEmailServiceName: z.string().max(120).optional().default(''),
  // Optional for backward-compat with accounts created before this field
  // existed; required at link-domain time, validated in the service layer.
  azureCommunicationServiceName: z.string().min(1).max(120).optional().nullable(),
  mailgunApiKey: z.string().max(2000).optional().nullable(),
  mailgunApiBaseUrl: z.string().url().max(200).optional().nullable(),
  mailgunWebhookSigningKey: z.string().max(2000).optional().nullable(),
  resendApiKey: z.string().max(2000).optional().nullable(),
  resendApiBaseUrl: z.string().url().max(200).optional().nullable(),
  resendWebhookSigningKey: z.string().max(2000).optional().nullable(),
});

function validateProviderConfig(
  v: z.infer<typeof EmailChannelBaseSchema>,
  ctx: z.RefinementCtx,
) {
  if (v.provider === 'acs') {
    for (const key of [
      'azureTenantId',
      'azureClientId',
      'azureClientSecret',
      'azureSubscriptionId',
      'azureResourceGroup',
      'azureEmailServiceName',
    ] as const) {
      if (!v[key]?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Required for ACS',
        });
      }
    }
  }
  if (v.provider === 'mailgun' && !v.mailgunApiKey?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mailgunApiKey'], message: 'Required for Mailgun' });
  }
  if (v.provider === 'resend' && !v.resendApiKey?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resendApiKey'], message: 'Required for Resend' });
  }
}

export const CreateEmailChannelSchema = EmailChannelBaseSchema.superRefine(validateProviderConfig);
export type CreateEmailChannelInput = z.infer<typeof CreateEmailChannelSchema>;

export const UpdateEmailChannelSchema = EmailChannelBaseSchema.partial();
export type UpdateEmailChannelInput = z.infer<typeof UpdateEmailChannelSchema>;

export interface EmailChannelView {
  id: string;
  provider: EmailChannelProviderValue;
  name: string;
  rpsLimit: number;
  rpmLimit: number;
  rphLimit: number;
  rpdLimit: number;
  status: EmailChannelStatusValue;
  azureTenantId: string;
  azureClientId: string;
  /** Redacted in list, full in single-get (same convention as connectionString). */
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
  /** Whether this account is the platform-wide default for new signups. */
  isDefault: boolean;
  senderDomainCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Set the full set of email channels a tenant may send through, plus which one is
 * primary. An empty list clears all assignments. `primaryEmailChannelId` must be a
 * member of `emailChannelIds` (or null when the list is empty).
 */
export const AssignEmailChannelsSchema = z
  .object({
    emailChannelIds: z.array(z.string().uuid()).max(50).optional(),
    emailChannels: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            allowMarketing: z.boolean().default(true),
            allowTransactional: z.boolean().default(true),
          })
          .refine((v) => v.allowMarketing || v.allowTransactional, {
            message: '邮件通道至少需要选择一个可用场景',
          }),
      )
      .max(50)
      .optional(),
    primaryEmailChannelId: z.string().uuid().nullable(),
  })
  .refine(
    (v) => {
      const ids = v.emailChannels?.map((a) => a.id) ?? v.emailChannelIds ?? [];
      return ids.length === 0
        ? v.primaryEmailChannelId === null
        : v.primaryEmailChannelId !== null && ids.includes(v.primaryEmailChannelId);
    },
    { message: '主邮件通道必须是已分配集合中的一个' },
  );
export type AssignEmailChannelsInput = z.infer<typeof AssignEmailChannelsSchema>;

/** A single email-channel assignment for a tenant, as shown in admin/tenant views. */
export interface AssignedEmailChannelView {
  id: string;
  name: string;
  provider: EmailChannelProviderValue;
  status: EmailChannelStatusValue;
  isPrimary: boolean;
  allowMarketing: boolean;
  allowTransactional: boolean;
}

export interface AdminAccountView {
  id: string;
  name: string;
  slug: string;
  /** All email channels assigned to this tenant; one has isPrimary=true. */
  emailChannels: AssignedEmailChannelView[];
  senderDomainCount: number;
  sendQuotaRemaining: number;
  status: 'pending_activation' | 'active' | 'suspended';
  activatedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  /** Owner email — shown in the admin table so the operator knows who they're suspending. */
  ownerEmail: string | null;
  /**
   * The tenant's role, derived from the owner user's platform-admin flag and the
   * account's collaborator flag (precedence: platform_admin > collaborator >
   * tenant). 普通租户 (tenant) gets the softened analytics view (soft bounces
   * folded into 送达, 弹回邮箱率 hidden); 合作者/平台管理员 see real data.
   */
  role: AccountRole;
  createdAt: string;
}

/**
 * The three mutually-exclusive tenant roles surfaced in 租户管理:
 *  - platform_admin: owner user is a global platform admin
 *  - collaborator:   trusted partner, sees real deliverability data
 *  - tenant:         normal tenant, softened analytics view
 */
export const ACCOUNT_ROLES = ['platform_admin', 'collaborator', 'tenant'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** Set a tenant's role (admin-only). Maps to is_platform_admin / is_collaborator. */
export const SetAccountRoleSchema = z.object({
  role: z.enum(ACCOUNT_ROLES),
});
export type SetAccountRoleInput = z.infer<typeof SetAccountRoleSchema>;

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
