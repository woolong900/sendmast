import { z } from 'zod';

/** Pool member statuses surfaced to the admin UI. See schema.prisma. */
export type TrackingDomainStatus = 'active' | 'disabled';

/**
 * Bare hostname validator. We only accept `[a-z0-9.-]+\.[a-z]{2,}` and lowercase
 * the input on the server — the registrar / Cloudflare / Caddy all treat hosts
 * case-insensitively, so storing one canonical form keeps the unique index honest.
 *
 * No protocol/path/port: this is the host that goes into a Caddy site block,
 * and `worker-sender` builds `https://<host>/t/...` itself.
 */
const DomainName = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, '请输入合法域名(不带协议和路径)');

export const CreateTrackingDomainSchema = z.object({
  domain: DomainName,
  /** Optional admin note (registrar, purchase date, anything searchable). */
  notes: z.string().max(500).optional().nullable(),
});
export type CreateTrackingDomainInput = z.infer<typeof CreateTrackingDomainSchema>;

export const UpdateTrackingDomainSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  notes: z.string().max(500).optional().nullable(),
});
export type UpdateTrackingDomainInput = z.infer<typeof UpdateTrackingDomainSchema>;

export interface TrackingDomainView {
  id: string;
  domain: string;
  status: TrackingDomainStatus;
  healthStatus: 'unknown' | 'healthy' | 'failed';
  dnsOk: boolean | null;
  tlsOk: boolean | null;
  caddyOk: boolean | null;
  httpStatus: number | null;
  latencyMs: number | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  consecutiveFailures: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackingDomainCheckResult {
  ok: boolean;
  domain: string;
  url: string;
  status: number | null;
  dnsOk: boolean;
  tlsOk: boolean;
  caddyOk: boolean;
  consecutiveFailures: number;
  disabled: boolean;
  latencyMs: number;
  checkedAt: string;
  message: string;
}
