import { z } from 'zod';

// ----------------------------------------------------------------------------
// Pricing tiers (admin manages)
// ----------------------------------------------------------------------------
//
// USD only on the tier table. The payment gateway (Shouqianba, fronting
// Alipay/WeChat) only settles in CNY — we convert USD→CNY ourselves at
// order creation using the FX rate from FxService and snapshot both
// `amount_cny` and `fx_rate` onto the order for audit.

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

/** Payment channel chosen by the user before placing the order. The
 *  precreate API returns a channel-specific QR — Alipay's QR is only
 *  scannable by the Alipay app, WeChat's only by WeChat. There is no
 *  "universal" QR available in 收钱吧's C-scan-B mode, so the modal must
 *  ask up front. */
export type PaymentChannel = 'alipay' | 'wechat';

export const CreateQuotaOrderSchema = z.object({
  tierId: z.string().uuid(),
  channel: z.enum(['alipay', 'wechat']).default('alipay'),
});
export type CreateQuotaOrderInput = z.infer<typeof CreateQuotaOrderSchema>;

export interface CreateQuotaOrderResponse {
  orderId: string;
  /** Raw `qr_code` payload from Shouqianba's `/upay/v2/precreate` response.
   *  For `channel='alipay'` it's `https://qr.alipay.com/...` and only the
   *  Alipay app can scan it; for `channel='wechat'` it's a wxpay URL the
   *  WeChat app handles. The frontend renders whichever it is. */
  qrCode: string;
  /** Echo of the channel the order was placed on, so the QR-code step
   *  can show the right "请使用 {Alipay|WeChat} 扫码" instruction. */
  channel: PaymentChannel;
  /** CNY amount the user will pay (already converted from USD at the
   *  current FX rate). Surfaced so the modal can show ¥X.XX next to the QR. */
  amountCny: number;
  /** USD price at the order's tier — useful for the modal subtitle. */
  amountUsd: number;
}

export type QuotaOrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled';

export interface QuotaOrderView {
  id: string;
  emails: number;
  amountUsd: number;
  /** CNY actually charged via Shouqianba (gateway only settles in CNY). */
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
