import { z } from 'zod';

// ----------------------------------------------------------------------------
// Pricing tiers (admin manages)
// ----------------------------------------------------------------------------
//
// USD only on the tier table. Checkout is charged in CNY through Airwallex,
// so we convert USD→CNY at order creation and snapshot both `amount_cny`
// and `fx_rate` onto the order for audit.

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
});
export type CreateQuotaOrderInput = z.infer<typeof CreateQuotaOrderSchema>;

export interface CreateQuotaOrderResponse {
  /** Airwallex PaymentIntent ID; also used to poll our order status. */
  orderId: string;
  /** Short-lived client credential for Airwallex Hosted Payment Page. */
  clientSecret: string;
  currency: 'CNY';
  environment: 'demo' | 'prod';
  successUrl: string;
  /** CNY amount the user will pay, converted from USD at the current rate. */
  amountCny: number;
  /** USD price at the order's tier — useful for the modal subtitle. */
  amountUsd: number;
}

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
