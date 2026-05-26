import { z } from 'zod';

// ----------------------------------------------------------------------------
// Referral channel (admin-managed partner / reseller)
// ----------------------------------------------------------------------------
//
// Each channel exposes a short URL-safe `code` that anchors a public
// referral link: `/signup?ref=<code>`. Codes are alphanumeric (no
// lookalikes) so they can be shared on chat / print without garbling.

/** Allowed shape of a channel code. 4–24 chars, [A-Z0-9] only — uppercase
 *  is enforced server-side by uppercasing on input so user-typed lowercase
 *  links still resolve. */
export const REFERRAL_CODE_REGEX = /^[A-Z0-9]{4,24}$/;

export const ReferralChannelInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(REFERRAL_CODE_REGEX, '推荐码只能包含大写字母和数字,长度 4-24 位'),
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().max(200).optional().nullable(),
  payoutInfo: z.string().trim().max(2000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  active: z.boolean().default(true),
});
export type ReferralChannelInput = z.infer<typeof ReferralChannelInputSchema>;

export interface ReferralChannelView {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  payoutInfo: string | null;
  notes: string | null;
  active: boolean;
  /** Total accounts that signed up through this channel. */
  referredAccountCount: number;
  /** Lifetime commission accrued (CNY). */
  totalCommissionCny: number;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------------------
// Public referral resolution — used by the signup page to display the
// channel's name in a "由 XXX 推荐" banner before form submit.
// ----------------------------------------------------------------------------

export interface ReferralLookupView {
  /** Echoed back canonicalised (uppercased, trimmed). */
  code: string;
  /** The channel's display name. Empty / missing → invalid code. */
  name: string;
}

// ----------------------------------------------------------------------------
// Global commission rate (singleton setting)
// ----------------------------------------------------------------------------

export const ReferralSettingInputSchema = z.object({
  /** Percent: 0–100, two decimals. Stored as Decimal(5,2). */
  ratePercent: z.coerce.number().min(0).max(100),
});
export type ReferralSettingInput = z.infer<typeof ReferralSettingInputSchema>;

export interface ReferralSettingView {
  ratePercent: number;
  updatedAt: string;
}

// ----------------------------------------------------------------------------
// Commission records (read-only list + monthly CSV export)
// ----------------------------------------------------------------------------

export interface CommissionRecordView {
  id: string;
  channelId: string;
  channelCode: string;
  channelName: string;
  /** Tenant name + owner email for context in the export. */
  accountId: string;
  accountName: string;
  accountOwnerEmail: string | null;
  /** Underlying paid order; useful if ops needs to cross-reference. */
  orderId: string;
  orderAmountCny: number;
  ratePercent: number;
  commissionCny: number;
  paidAt: string;
  createdAt: string;
}

/** Month string in `YYYY-MM` format. */
export const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式必须为 YYYY-MM');

export const CommissionExportQuerySchema = z.object({
  month: MonthSchema,
  channelId: z.string().uuid().optional(),
});
export type CommissionExportQuery = z.infer<typeof CommissionExportQuerySchema>;

/** Per-channel rollup for a given month — what the admin sees above the
 *  detail table and what each row of the CSV summary section contains. */
export interface CommissionMonthlySummaryRow {
  channelId: string;
  channelCode: string;
  channelName: string;
  orderCount: number;
  orderAmountCny: number;
  commissionCny: number;
}

export interface CommissionMonthlySummary {
  month: string;
  totalOrderCount: number;
  totalOrderAmountCny: number;
  totalCommissionCny: number;
  rows: CommissionMonthlySummaryRow[];
}
