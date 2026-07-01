import { z } from 'zod';

/**
 * Admin send-log query. All filters are optional and combine via AND.
 * `domain` matches `from_address LIKE '%@<domain>'` (no autocomplete).
 * `from`/`to` are ISO timestamps; either side may be omitted.
 */
export const SendLogQuerySchema = z.object({
  accountId: z.string().uuid().optional(),
  emailChannelId: z.string().uuid().optional(),
  source: z.enum(['campaign', 'automation']).optional(),
  domain: z.string().min(1).max(253).optional(),
  /** 'true' / 'false' / undefined (all) — query strings are strings. */
  ok: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => (typeof v === 'string' ? v === 'true' : v)),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SendLogQuery = z.infer<typeof SendLogQuerySchema>;

export interface SendLogView {
  id: string;
  sentAt: string;
  account: { id: string; name: string; slug: string };
  emailChannel: { id: string; name: string } | null;
  source: 'campaign' | 'automation';
  campaign: { id: string; name: string } | null;
  automation: { id: string; type: string; shopName: string | null } | null;
  recipientId: string | null;
  automationSendId: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  ok: boolean;
  providerStatus: string | null;
  messageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  responsePayload: unknown;
}

export interface SendLogListResponse {
  rows: SendLogView[];
  total: number;
  offset: number;
  limit: number;
}

export interface SendLogContentView {
  subject: string | null;
  preheader: string | null;
  html: string | null;
  source: 'campaign' | 'automation_send' | 'automation' | null;
}

export interface SendLogDetailResponse extends SendLogView {
  content: SendLogContentView;
}
