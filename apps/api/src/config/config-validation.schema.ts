import { z } from 'zod';

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    API_PORT: z.coerce.number().int().default(4000),
    API_BASE_URL: z.string().url().default('http://localhost:4000'),
    WEB_BASE_URL: z.string().url().default('http://localhost:5173'),
    TRACKING_BASE_URL: z.string().url().default('http://localhost:4000'),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    CLICKHOUSE_URL: z.string().url().default('http://localhost:8123'),
    CLICKHOUSE_DATABASE: z.string().default('sendmast'),
    CLICKHOUSE_USER: z.string().default('default'),
    CLICKHOUSE_PASSWORD: z.string().default(''),

    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_BUCKET: z.string().default('sendmast-uploads'),
    S3_PUBLIC_BUCKET: z.string().default('sendmast-public'),

    // HS256 secret strength: NIST SP 800-107 recommends >= key-length-equivalent
    // of the HMAC output (32 bytes for SHA-256). 16-byte secrets are brute-force-
    // weak; reject them at boot so dev/staging never accidentally ships one to
    // prod. Generate fresh ones with: `openssl rand -base64 48`.
    JWT_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),

    TRACKING_TOKEN_SECRET: z.string().min(32),

    // Shared secret guarding the Azure Event Grid webhook. Optional for local
    // development, but production refuses to boot without a strong value.
    EVENTGRID_WEBHOOK_KEY: z.string().min(32).optional(),

    // Shopyy (OEMSAAS) e-commerce integration. ALL optional at boot — the
    // integrations service checks `isConfigured()` (SHOPYY_APP_SECRET present)
    // before letting a tenant connect a store, so a box without partner creds
    // still starts and the settings page shows "未配置".
    //
    // APP_KEY/APP_SECRET are the partnership-issued application credentials used
    // to SIGN the authorize-token exchange (the only call that uses the secret;
    // everything after uses the per-store devToken). WEBHOOK_BASE_URL is where
    // shopyy should deliver order/checkout webhooks — defaults to API_BASE_URL.
    SHOPYY_APP_KEY: z.string().optional(),
    SHOPYY_APP_SECRET: z.string().optional(),
    // Partner credential shopyy now requires as the `Tp-Partner-Id` header on
    // every OpenAPI call (paired with a fixed partner User-Agent). Missing → the
    // header is omitted and shopyy may reject calls.
    SHOPYY_PARTNER_ID: z.string().optional(),
    SHOPYY_WEBHOOK_BASE_URL: z.string().url().optional(),

    // Shouqianba (收钱吧) for self-service quota top-up via 当面付/扫码支付.
    // ALL fields are optional at boot — QuotaBilling checks `isConfigured()`
    // before letting users place orders, so a fresh dev box without merchant
    // creds still starts. (We use Shouqianba instead of Alipay direct because
    // Alipay 风控 rejected our merchant for online SaaS use; Shouqianba is
    // an aggregator that fronts Alipay/WeChat under one approvable contract.)
    //
    // vendor_sn / vendor_key are the ISV-level credentials used ONLY for the
    // one-time terminal activation (we run the activation script ourselves
    // off-box and persist the result). At runtime, signing uses
    // terminal_sn / terminal_key — those are what the billing service reads.
    SHOUQIANBA_GATEWAY: z.string().url().default('https://vsi-api.shouqianba.com'),
    SHOUQIANBA_APP_ID: z.string().optional(),
    SHOUQIANBA_VENDOR_SN: z.string().optional(),
    SHOUQIANBA_VENDOR_KEY: z.string().optional(),
    /** Returned by /terminal/activate. Persist + reuse — only re-activate
     *  when keys are rotated or the device_id is unbound by support. */
    SHOUQIANBA_TERMINAL_SN: z.string().optional(),
    SHOUQIANBA_TERMINAL_KEY: z.string().optional(),

    // Switches new quota orders only. Existing pending orders continue to be
    // reconciled with the provider recorded on each order.
    QUOTA_PAYMENT_PROVIDER: z.enum(['shouqianba', 'airwallex']).default('shouqianba'),

    // Airwallex hosted checkout for new self-service quota top-ups. API
    // credentials remain server-side; only PaymentIntent client secrets are
    // returned to the browser for the provider-hosted checkout session.
    AIRWALLEX_ENV: z.enum(['demo', 'production']).default('demo'),
    AIRWALLEX_CLIENT_ID: z.string().optional(),
    AIRWALLEX_API_KEY: z.string().optional(),
    AIRWALLEX_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && !config.EVENTGRID_WEBHOOK_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVENTGRID_WEBHOOK_KEY'],
        message: 'Required in production',
      });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function validateConfig(raw: Record<string, unknown>): AppConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.errors
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${errors}`);
  }
  return parsed.data;
}
