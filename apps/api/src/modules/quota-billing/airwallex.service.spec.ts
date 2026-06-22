import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { AirwallexService } from './airwallex.service';

describe('AirwallexService', () => {
  const config = new ConfigService({
    AIRWALLEX_ENV: 'demo',
    AIRWALLEX_CLIENT_ID: 'client-id',
    AIRWALLEX_API_KEY: 'api-key',
    AIRWALLEX_WEBHOOK_SECRET: 'webhook-secret',
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('verifies a current webhook signature against the raw body', () => {
    const service = new AirwallexService(config);
    const timestamp = String(Date.now());
    const body = '{"name":"payment_intent.succeeded"}';
    const signature = createHmac('sha256', 'webhook-secret')
      .update(`${timestamp}${body}`)
      .digest('hex');

    expect(service.verifyWebhook(body, timestamp, signature)).toBe(true);
    expect(service.verifyWebhook(`${body} `, timestamp, signature)).toBe(false);
  });

  it('rejects stale webhook signatures', () => {
    const service = new AirwallexService(config);
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    const body = '{}';
    const signature = createHmac('sha256', 'webhook-secret')
      .update(`${timestamp}${body}`)
      .digest('hex');

    expect(service.verifyWebhook(body, timestamp, signature)).toBe(false);
  });

  it('authenticates and creates a CNY PaymentIntent', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'access-token',
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'int_test',
            client_secret: 'secret_test',
            status: 'REQUIRES_PAYMENT_METHOD',
            amount: 12.34,
            currency: 'CNY',
            merchant_order_id: 'sm-order',
          }),
          { status: 201 },
        ),
      );
    const service = new AirwallexService(config);

    const intent = await service.createPaymentIntent({
      requestId: 'request-id',
      merchantOrderId: 'sm-order',
      amountCny: 12.34,
      returnUrl: 'https://example.com/settings/orders',
      description: 'quota',
    });

    expect(intent).toMatchObject({
      id: 'int_test',
      clientSecret: 'secret_test',
      amount: 12.34,
      currency: 'CNY',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api-demo.airwallex.com/api/v1/pa/payment_intents/create',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
      }),
    );
  });

  it('blocks checkout when no active payment method is configured', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'access-token',
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ has_more: false, items: [] }), { status: 200 }),
      );
    const service = new AirwallexService(config);

    await expect(service.ensurePaymentMethodAvailable()).rejects.toThrow(
      '空中云汇账户尚未启用可用的收款方式',
    );
  });
});
