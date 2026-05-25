import { z } from 'zod';

const ConfigSchema = z.object({
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
