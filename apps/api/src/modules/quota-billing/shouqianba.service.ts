import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

/**
 * Minimal 收钱吧 (Shouqianba) client for online QR-code payment.
 *
 * Why this replaces our Alipay path: Alipay 风控 rejected our merchant
 * application for online SaaS use of 当面付. 收钱吧 is an aggregator
 * (聚合支付) that fronts both Alipay and WeChat Pay channels under one
 * API — they take on the merchant qualification heavy-lifting and we get
 * a single integration that 'just works'. Cost: ~0.3% extra fee vs direct
 * Alipay; benefit: actually approvable.
 *
 * Surface we use:
 *   - createQrCode  → POST /upay/v2/precreate (C scans B mode)
 *   - queryOrder    → POST /upay/v2/query (authoritative order status)
 *
 * Auth model:
 *   - Activation (one-shot, NOT here): vendor_sn + vendor_key sign
 *     /terminal/activate, response includes terminal_sn / terminal_key.
 *     We persist those into env (SHOUQIANBA_TERMINAL_SN/KEY) ourselves —
 *     this service never re-activates.
 *   - Runtime: Authorization header is `<terminal_sn> <md5(body+terminal_key)>`.
 *     One header, one MD5, no public-key crypto, no PEM gymnastics.
 *
 * Why we don't verify async notify signatures here: Shouqianba signs
 * notify with RSA-2048 against an undocumented public key (the docs
 * vaguely say "use our public key" without telling you where to fetch
 * it). Rather than fight that, we treat each notify as a HINT — "go
 * check this client_sn" — and call queryOrder() for the authoritative
 * status. Query is signed with OUR terminal_key, so the result is
 * unforgeable; an attacker spamming /shouqianba/notify with fake bodies
 * gets filtered upstream (we only query for client_sn values we wrote
 * ourselves) and would still need our terminal_key to ever get a PAID
 * back. This is the same pattern Stripe / Square recommend (treat
 * webhook as event-trigger, fetch state from API).
 *
 * Money: Shouqianba quotes amounts in 分 (integer cents) as a string.
 * The caller passes a CNY decimal — we multiply ×100 + round here.
 *
 * Spec: https://doc.shouqianba.com/zh-cn/api/sign.html
 *       https://doc.shouqianba.com/zh-cn/api/interface/precreate.html
 */
@Injectable()
export class ShouqianbaService {
  private readonly logger = new Logger(ShouqianbaService.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('SHOUQIANBA_TERMINAL_SN') &&
        this.config.get<string>('SHOUQIANBA_TERMINAL_KEY'),
    );
  }

  /**
   * Precreate a 当面付 order. Returns the raw `qr_code` string (an
   * https://qr.shouqianba.com/... URL) which the frontend renders to a
   * QR image; the buyer scans it from Alipay/WeChat to pay.
   *
   * Throws ServiceUnavailableException on:
   *   - missing config (admin hasn't pasted keys / activated terminal)
   *   - HTTP transport error
   *   - non-200 result_code OR non-PRECREATE_SUCCESS biz result
   */
  async createQrCode(args: {
    outTradeNo: string;
    totalAmountCny: number;
    subject: string;
    notifyUrl: string;
    /** 1=Alipay, 3=WeChat Pay. Default Alipay since most CN users have it.
     *  When we want a multi-channel UI we'll let the modal pick this. */
    payway?: '1' | '3';
  }): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('支付通道未配置');
    }
    const terminalSn = this.config.getOrThrow<string>('SHOUQIANBA_TERMINAL_SN');
    const terminalKey = this.config.getOrThrow<string>('SHOUQIANBA_TERMINAL_KEY');
    const gateway = this.config.getOrThrow<string>('SHOUQIANBA_GATEWAY');

    const body = {
      terminal_sn: terminalSn,
      client_sn: args.outTradeNo,
      // Shouqianba accepts amount in 分 as a string. round() rather than
      // floor()/trunc() so 14.995 doesn't silently undercharge.
      total_amount: Math.round(args.totalAmountCny * 100).toString(),
      payway: args.payway ?? '1',
      subject: args.subject,
      operator: 'system',
      notify_url: args.notifyUrl,
    };
    const raw = JSON.stringify(body);
    const auth = `${terminalSn} ${this.sign(raw, terminalKey)}`;

    let respText: string;
    try {
      const res = await fetch(`${gateway}/upay/v2/precreate`, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
        },
        body: raw,
      });
      respText = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Shouqianba precreate transport error: ${msg}`);
      throw new ServiceUnavailableException('支付网关不可达,请稍后重试');
    }

    let parsed: {
      result_code?: string;
      error_message?: string;
      biz_response?: {
        result_code?: string;
        error_message?: string;
        error_code?: string;
        data?: {
          qr_code?: string;
          sn?: string;
          order_status?: string;
        };
      };
    };
    try {
      parsed = JSON.parse(respText);
    } catch {
      this.logger.error(`Shouqianba precreate non-JSON response: ${respText.slice(0, 200)}`);
      throw new ServiceUnavailableException('支付网关返回异常');
    }

    if (parsed.result_code !== '200') {
      this.logger.error(
        `Shouqianba precreate transport error: result_code=${parsed.result_code} msg=${parsed.error_message}`,
      );
      throw new ServiceUnavailableException(parsed.error_message ?? '支付下单失败');
    }
    const biz = parsed.biz_response;
    if (!biz || biz.result_code !== 'PRECREATE_SUCCESS') {
      // Common biz failures: AUTH_CODE_ERROR, ORDER_PAID, INVALID_PARAMETER,
      // MERCHANT_AGREEMENT_NOT_EXIST. error_message is human-readable.
      this.logger.error(
        `Shouqianba precreate biz error: result=${biz?.result_code} code=${biz?.error_code} msg=${biz?.error_message}`,
      );
      throw new ServiceUnavailableException(biz?.error_message ?? '下单失败');
    }
    const qr = biz.data?.qr_code;
    if (!qr) {
      this.logger.error(`Shouqianba precreate ok but no qr_code: ${respText.slice(0, 200)}`);
      throw new ServiceUnavailableException('支付网关未返回二维码');
    }
    return qr;
  }

  /**
   * Authoritative order-status lookup. Returns the parsed `data` block
   * from `/upay/v2/query` — the caller cares about `order_status` ('PAID'
   * being the only success terminal) and `trade_no` (the upstream
   * Alipay/WeChat trade id, useful for accounting cross-reference).
   *
   * Returns `null` when Shouqianba reports the order as unknown. Any other
   * failure (network, signing, biz error) raises ServiceUnavailable so
   * the notify handler short-circuits and lets Shouqianba retry — that's
   * the documented contract anyway (return non-`success` to ask for retry).
   */
  async queryOrder(clientSn: string): Promise<ShouqianbaOrderStatus | null> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('支付通道未配置');
    }
    const terminalSn = this.config.getOrThrow<string>('SHOUQIANBA_TERMINAL_SN');
    const terminalKey = this.config.getOrThrow<string>('SHOUQIANBA_TERMINAL_KEY');
    const gateway = this.config.getOrThrow<string>('SHOUQIANBA_GATEWAY');

    const body = JSON.stringify({ terminal_sn: terminalSn, client_sn: clientSn });
    const auth = `${terminalSn} ${this.sign(body, terminalKey)}`;

    let respText: string;
    try {
      const res = await fetch(`${gateway}/upay/v2/query`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body,
      });
      respText = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Shouqianba query transport error: ${msg}`);
      throw new ServiceUnavailableException('支付查询网关不可达');
    }

    let parsed: {
      result_code?: string;
      error_code?: string;
      error_message?: string;
      biz_response?: {
        result_code?: string;
        error_code?: string;
        error_message?: string;
        data?: { order_status?: string; trade_no?: string; sn?: string };
      };
    };
    try {
      parsed = JSON.parse(respText);
    } catch {
      this.logger.error(`Shouqianba query non-JSON response: ${respText.slice(0, 200)}`);
      throw new ServiceUnavailableException('支付查询网关返回异常');
    }

    if (parsed.result_code !== '200') {
      throw new ServiceUnavailableException(parsed.error_message ?? '支付查询失败');
    }
    const biz = parsed.biz_response;
    // Shouqianba emits `result_code: 'FAIL'` + `error_code: 'ORDER_NOT_EXIST'`
    // for client_sn values it has never seen. Treat that as null (caller
    // ignores the notify) rather than blowing up.
    if (biz?.error_code === 'ORDER_NOT_EXIST') return null;
    if (!biz || biz.result_code !== 'SUCCESS' || !biz.data?.order_status) {
      throw new ServiceUnavailableException(biz?.error_message ?? '支付查询失败');
    }
    return {
      orderStatus: biz.data.order_status,
      tradeNo: biz.data.trade_no || biz.data.sn || null,
    };
  }

  /**
   * Cancel (撤单) an order so its QR can no longer be paid. Used by the
   * stale-order sweep to permanently close abandoned unpaid orders — once the
   * gateway confirms cancel, a late scan can't pay it, which is what makes it
   * safe for us to then mark the order cancelled locally.
   *
   * CALLER CONTRACT: only call this for orders you've confirmed are NOT paid.
   * 撤单 on an already-paid 当面付 order triggers a refund at the gateway.
   *
   * Returns true when the gateway confirms the order is closed (CANCEL_SUCCESS)
   * or never existed there (ORDER_NOT_EXIST — nothing to pay). Returns false on
   * any transport / biz failure so the caller leaves the order pending and
   * retries on the next sweep rather than risking a late payment we'd drop.
   */
  async cancelOrder(clientSn: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const terminalSn = this.config.getOrThrow<string>('SHOUQIANBA_TERMINAL_SN');
    const terminalKey = this.config.getOrThrow<string>('SHOUQIANBA_TERMINAL_KEY');
    const gateway = this.config.getOrThrow<string>('SHOUQIANBA_GATEWAY');

    const body = JSON.stringify({ terminal_sn: terminalSn, client_sn: clientSn });
    const auth = `${terminalSn} ${this.sign(body, terminalKey)}`;

    let respText: string;
    try {
      const res = await fetch(`${gateway}/upay/v2/cancel`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body,
      });
      respText = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Shouqianba cancel transport error for ${clientSn}: ${msg}`);
      return false;
    }

    let parsed: {
      result_code?: string;
      biz_response?: { result_code?: string; error_code?: string; error_message?: string };
    };
    try {
      parsed = JSON.parse(respText);
    } catch {
      this.logger.warn(`Shouqianba cancel non-JSON response for ${clientSn}: ${respText.slice(0, 200)}`);
      return false;
    }
    if (parsed.result_code !== '200') return false;
    const biz = parsed.biz_response;
    // Nothing on the gateway side to pay → treat as closed.
    if (biz?.error_code === 'ORDER_NOT_EXIST') return true;
    return biz?.result_code === 'CANCEL_SUCCESS';
  }

  // ---------- internal --------------------------------------------------

  private sign(body: string, key: string): string {
    return createHash('md5').update(body + key, 'utf8').digest('hex');
  }
}

export interface ShouqianbaOrderStatus {
  /** Shouqianba states: CREATED, PAID, PAY_CANCELED, PAY_ERROR, REFUNDED,
   *  PARTIAL_REFUNDED. Only PAID credits the buyer's quota. */
  orderStatus: string;
  /** Underlying Alipay / WeChat trade id, surfaced for accounting. May be
   *  null while the order is still in CREATED state. */
  tradeNo: string | null;
}
