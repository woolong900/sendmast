import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

interface AirwallexAccessToken {
  value: string;
  expiresAt: number;
}

export interface AirwallexPaymentIntent {
  id: string;
  clientSecret: string | null;
  status: string;
  amount: number;
  currency: string;
  merchantOrderId: string | null;
  latestPaymentAttemptId: string | null;
}

@Injectable()
export class AirwallexService {
  private readonly logger = new Logger(AirwallexService.name);
  private accessToken?: AirwallexAccessToken;
  private paymentMethodsCache?: { available: boolean; checkedAt: number };

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('AIRWALLEX_CLIENT_ID') &&
        this.config.get<string>('AIRWALLEX_API_KEY'),
    );
  }

  checkoutEnvironment(): 'demo' | 'prod' {
    return this.config.get<string>('AIRWALLEX_ENV') === 'production' ? 'prod' : 'demo';
  }

  async ensurePaymentMethodAvailable(): Promise<void> {
    if (
      this.paymentMethodsCache &&
      this.paymentMethodsCache.checkedAt > Date.now() - 5 * 60 * 1000
    ) {
      if (!this.paymentMethodsCache.available) {
        throw new ServiceUnavailableException('空中云汇账户尚未启用可用的收款方式');
      }
      return;
    }

    const result = await this.request<{
      items?: Array<{ active?: boolean; name?: string }>;
    }>(
      '/api/v1/pa/config/payment_method_types' +
        '?active=true&transaction_mode=oneoff&transaction_currency=CNY&country_code=CN',
    );
    const available = Boolean(result.items?.some((item) => item.active !== false && item.name));
    this.paymentMethodsCache = { available, checkedAt: Date.now() };
    if (!available) {
      throw new ServiceUnavailableException('空中云汇账户尚未启用可用的收款方式');
    }
  }

  async createPaymentIntent(args: {
    requestId: string;
    merchantOrderId: string;
    amountCny: number;
    returnUrl: string;
    description: string;
  }): Promise<AirwallexPaymentIntent> {
    const result = await this.request<AirwallexPaymentIntentResponse>(
      '/api/v1/pa/payment_intents/create',
      {
        method: 'POST',
        body: JSON.stringify({
          request_id: args.requestId,
          merchant_order_id: args.merchantOrderId,
          amount: args.amountCny,
          currency: 'CNY',
          return_url: args.returnUrl,
          descriptor: 'SENDMAST',
          metadata: {
            product: 'email_quota',
            description: args.description,
          },
        }),
      },
    );
    return this.mapIntent(result);
  }

  async retrievePaymentIntent(id: string): Promise<AirwallexPaymentIntent | null> {
    try {
      const result = await this.request<AirwallexPaymentIntentResponse>(
        `/api/v1/pa/payment_intents/${encodeURIComponent(id)}`,
      );
      return this.mapIntent(result);
    } catch (err) {
      if (err instanceof AirwallexNotFoundError) return null;
      throw err;
    }
  }

  async cancelPaymentIntent(id: string): Promise<boolean> {
    try {
      const result = await this.request<AirwallexPaymentIntentResponse>(
        `/api/v1/pa/payment_intents/${encodeURIComponent(id)}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({
            request_id: randomUUID(),
            cancellation_reason: 'Payment session expired',
          }),
        },
      );
      return result.status === 'CANCELLED';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Airwallex cancel failed for ${id}: ${msg}`);
      return false;
    }
  }

  verifyWebhook(rawBody: string, timestamp: string, signature: string): boolean {
    const secret = this.config.get<string>('AIRWALLEX_WEBHOOK_SECRET');
    if (!secret || !timestamp || !signature) return false;

    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
      return false;
    }

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}${rawBody}`, 'utf8')
      .digest('hex');
    const actualBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('支付通道未配置');
    }

    const token = await this.getAccessToken();
    let response: Response;
    try {
      response = await fetch(`${this.apiBase()}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Airwallex request transport error for ${path}: ${msg}`);
      throw new ServiceUnavailableException('支付网关不可达,请稍后重试');
    }

    const text = await response.text();
    const payload = this.parseJson(text);
    if (!response.ok) {
      const code = typeof payload.code === 'string' ? payload.code : '';
      const message =
        typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
      this.logger.error(`Airwallex request failed for ${path}: ${code} ${message}`);
      if (response.status === 404) throw new AirwallexNotFoundError(message);
      throw new ServiceUnavailableException('支付网关请求失败,请稍后重试');
    }
    return payload as T;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }

    const clientId = this.config.getOrThrow<string>('AIRWALLEX_CLIENT_ID');
    const apiKey = this.config.getOrThrow<string>('AIRWALLEX_API_KEY');
    let response: Response;
    try {
      response = await fetch(`${this.apiBase()}/api/v1/authentication/login`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-client-id': clientId,
          'x-api-key': apiKey,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Airwallex authentication transport error: ${msg}`);
      throw new ServiceUnavailableException('支付网关认证失败');
    }

    const text = await response.text();
    const payload = this.parseJson(text);
    if (!response.ok || typeof payload.token !== 'string') {
      this.logger.error(`Airwallex authentication failed: HTTP ${response.status}`);
      throw new ServiceUnavailableException('支付网关认证失败');
    }

    const parsedExpiry =
      typeof payload.expires_at === 'string' ? Date.parse(payload.expires_at) : Number.NaN;
    this.accessToken = {
      value: payload.token,
      expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 25 * 60 * 1000,
    };
    return this.accessToken.value;
  }

  private apiBase(): string {
    return this.config.get<string>('AIRWALLEX_ENV') === 'production'
      ? 'https://api.airwallex.com'
      : 'https://api-demo.airwallex.com';
  }

  private parseJson(text: string): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.logger.error(`Airwallex returned non-JSON response: ${text.slice(0, 200)}`);
      throw new ServiceUnavailableException('支付网关返回异常');
    }
  }

  private mapIntent(intent: AirwallexPaymentIntentResponse): AirwallexPaymentIntent {
    return {
      id: intent.id,
      clientSecret: intent.client_secret ?? null,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      merchantOrderId: intent.merchant_order_id ?? null,
      latestPaymentAttemptId: intent.latest_payment_attempt?.id ?? null,
    };
  }
}

class AirwallexNotFoundError extends Error {}

interface AirwallexPaymentIntentResponse {
  id: string;
  client_secret?: string;
  status: string;
  amount: number;
  currency: string;
  merchant_order_id?: string;
  latest_payment_attempt?: { id?: string };
}
