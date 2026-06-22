import { z } from 'zod';

// ----------------------------------------------------------------------------
// Pricing tiers (admin manages)
// ----------------------------------------------------------------------------
//
// USD only on the tier table. Checkout is charged in CNY through the selected
// payment provider, so we snapshot the converted amount and FX rate for audit.

export const QuotaPricingTierInputSchema = z.object({
  emails: z.coerce.number().int().min(1),
  priceUsd: z.coerce.number().min(0),
  active: z.boolean(),
  sortOrder: z.coerce.number().int(),
});
export type QuotaPricingTierInput = z.infer<typeof QuotaPricingTierInputSchema>;

export interface QuotaPricingTierView {
  id: string;
  emails: number;
  priceUsd: number;
  /** Convenience for UI cards: "$0.0018/封" — server-computed so locales agree. */
  unitPriceUsd: number;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
}

// ----------------------------------------------------------------------------
// Orders (user creates, payment provider drives status)
// ----------------------------------------------------------------------------

export const CreateQuotaOrderSchema = z.object({
  tierId: z.string().uuid(),
  channel: z.enum(['alipay', 'wechat']).default('alipay'),
});
export type CreateQuotaOrderInput = z.infer<typeof CreateQuotaOrderSchema>;

export type PaymentChannel = 'alipay' | 'wechat';

interface QuotaOrderCheckoutBase {
  orderId: string;
  amountCny: number;
  amountUsd: number;
}

export interface ShouqianbaQuotaOrderResponse extends QuotaOrderCheckoutBase {
  provider: 'shouqianba';
  qrCode: string;
  channel: PaymentChannel;
}

export interface AirwallexQuotaOrderResponse extends QuotaOrderCheckoutBase {
  provider: 'airwallex';
  clientSecret: string;
  currency: 'CNY';
  environment: 'demo' | 'prod';
  successUrl: string;
}

export type CreateQuotaOrderResponse = ShouqianbaQuotaOrderResponse | AirwallexQuotaOrderResponse;

export type QuotaOrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled';

export interface QuotaOrderView {
  id: string;
  emails: number;
  amountUsd: number;
  /** CNY actually charged through the payment gateway. */
  amountCny: number;
  /** USD→CNY rate snapshotted at order creation. */
  fxRate: number;
  status: QuotaOrderStatus;
  provider: string;
  providerOrderId: string;
  paidAt: string | null;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// FX rate (USD → CNY for now; structure leaves room for more pairs later)
// ----------------------------------------------------------------------------

export interface FxRateView {
  base: string;
  quote: string;
  rate: number;
  /** Provider tag — `frankfurter` (auto, daily) or `manual` (admin refresh). */
  source: string;
  fetchedAt: string;
}

// ----------------------------------------------------------------------------
// Admin tier CRUD already covered by QuotaPricingTierInputSchema; only the
// "active" toggle needs a slim payload so admins can hide a tier without
// touching prices.
// ----------------------------------------------------------------------------

export const ToggleQuotaPricingTierSchema = z.object({
  active: z.boolean(),
});
export type ToggleQuotaPricingTierInput = z.infer<typeof ToggleQuotaPricingTierSchema>;
