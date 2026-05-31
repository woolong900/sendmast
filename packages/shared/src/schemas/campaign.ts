import { z } from 'zod';

export const CampaignStatusSchema = z.enum([
  'draft',
  'scheduled',
  'sending',
  'sent',
  'paused',
  'failed',
  'canceled',
]);
export type CampaignStatusValue = z.infer<typeof CampaignStatusSchema>;

/**
 * Which editor produced the campaign body. Picked in step 0 of the wizard;
 * step 2 then renders either Easy Email (visual) or a CodeMirror raw-HTML
 * editor (html). Switching modes mid-edit clears html/mjml/designJson so the
 * two editors never share state — see CampaignWizardPage step-0 toggle.
 */
export const EditorModeSchema = z.enum(['visual', 'html']);
export type EditorMode = z.infer<typeof EditorModeSchema>;

/**
 * One "from" identity a campaign can send as. Used by the multi-sender
 * feature: the wizard sends an array of these; the API rotates through them
 * per recipient (round-robin) at send time. `fromName` is derived on the
 * client from the chosen sender username's display name.
 */
export const CampaignSenderSchema = z.object({
  fromEmail: z.string().email(),
  fromName: z.string().min(1).max(80),
});
export type CampaignSenderInput = z.infer<typeof CampaignSenderSchema>;

export const CreateCampaignSchema = z.object({
  name: z.string().min(1).max(120),
  subject: z.string().min(1).max(200),
  preheader: z.string().max(200).optional(),
  fromName: z.string().min(1).max(80),
  fromEmail: z.string().email(),
  /**
   * Full sender roster for round-robin sending. When present and non-empty,
   * position 0 must equal { fromEmail, fromName } above (the primary). When
   * omitted, the campaign has a single sender (the primary) — backwards
   * compatible with all pre-feature clients. All senders must resolve to
   * verified domains under the same ACS account.
   */
  senders: z.array(CampaignSenderSchema).min(1).max(50).optional(),
  replyTo: z.string().email().optional(),
  templateId: z.string().uuid().optional(),
  mjml: z.string().optional(),
  html: z.string().optional(),
  designJson: z.unknown().optional(),
  /** Picked in step 0; defaults to 'visual' for backwards compat with all
   *  pre-feature campaigns. Determines which editor step 2 renders. */
  editorMode: EditorModeSchema.default('visual'),
  /** Pre-rendered preview thumbnail URL (PNG); generated client-side at content-save. */
  thumbnail: z.string().optional(),
  /** Whole-list targets — final audience = ∪(lists) ∪ ∪(segments), deduped by contactId. */
  listIds: z.array(z.string().uuid()).default([]),
  /** Dynamic-audience targets. At least one of listIds / segmentIds must be non-empty at send time. */
  segmentIds: z.array(z.string().uuid()).default([]),
  scheduledAt: z.string().datetime().optional(),
  utmEnabled: z.boolean().optional(),
  utmSource: z.string().max(80).optional(),
  utmMedium: z.string().max(80).optional(),
  utmCampaign: z.string().max(120).optional(),
  trackClicks: z.boolean().optional(),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

export const UpdateCampaignSchema = CreateCampaignSchema.partial();
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignSchema>;

export const ListCampaignsQuerySchema = z.object({
  search: z.string().optional(),
  status: CampaignStatusSchema.optional(),
  /// ISO 8601 — filter campaigns where `createdAt` is within [createdFrom, createdTo].
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListCampaignsQuery = z.infer<typeof ListCampaignsQuerySchema>;

// ----- recipient listing -----------------------------------------------------

// Mirrors Prisma's RecipientStatus enum (packages/db/prisma/schema.prisma).
// Keep these in sync — adding a value here without updating the enum will
// fail at the Prisma layer with an unhelpful error.
export const RecipientStatusSchema = z.enum([
  'pending',
  'queued',
  'sent',
  'failed',
  'skipped',
]);
export type RecipientStatusValue = z.infer<typeof RecipientStatusSchema>;

/**
 * Slicing dimension for the per-campaign recipient detail view. Each value
 * corresponds to one tab in 用户明细数据 page:
 *   sent / failed / invalid  → resolved from PG campaign_recipients
 *   delivered / opened / clicked / bounced / unsubscribed / complained
 *                            → resolved from ClickHouse email_events
 *   sales                    → orders pipeline (not yet wired) → empty list
 *
 * NOTE: `invalid` currently mirrors `bounced` because our webhook layer
 * doesn't split hard vs soft bounces; keep this semantically separate so the
 * UI can be honest about what it shows once we add the distinction.
 */
export const RecipientDimensionSchema = z.enum([
  'sent',
  'delivered',
  /** Accepted by ACS but no delivery report yet (in-transit / deferred). */
  'pending',
  'opened',
  'clicked',
  'sales',
  'failed',
  'invalid',
  'unsubscribed',
  'bounced',
  'complained',
]);
export type RecipientDimension = z.infer<typeof RecipientDimensionSchema>;

export const ListRecipientsQuerySchema = z.object({
  /** Default 'sent' = whole-send list, matches the 发送 tab in the UI. */
  dimension: RecipientDimensionSchema.default('sent'),
  /** Legacy filter still supported for direct PG lookups. */
  status: RecipientStatusSchema.optional(),
  /** Opaque page cursor, format depends on dimension (PG uses uuid, CH uses ISO ts). */
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRecipientsQuery = z.infer<typeof ListRecipientsQuerySchema>;

export interface RecipientView {
  id: string;
  email: string;
  /** Display name = first + last with fallback to email local part on the client. */
  firstName: string | null;
  lastName: string | null;
  status: string;
  messageId: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  /**
   * Dimension-specific timestamp shown in the table's right-most column.
   * For 'sent' this is sentAt; for event-based dimensions it's the latest
   * event_time from ClickHouse for that recipient.
   */
  eventTime: string | null;
  // ---- Optional event metadata ----------------------------------------------
  // Populated only for event-based dimensions where the column is shown.
  // The client decides which columns to render based on its current tab; the
  // backend always includes these when available so the response shape stays
  // stable regardless of which tab the user is on.
  /** Latest user_agent string seen for this recipient (for the queried event). */
  userAgent: string | null;
  /** For click events, the URL that was clicked. */
  linkUrl: string | null;
  /** For opened tab: when this recipient first received the message. */
  deliveredAt: string | null;
  /** Parsed reason text — surfaced in 退订/投诉 tabs. May be null in dev (no real webhook payload). */
  reason: string | null;
  /** For bounce events: classification (HardBounce / SoftBounce / Suppressed / ...). */
  bounceType: string | null;
}

export interface ListRecipientsResponse {
  /** 'hot' = served from PG; 'archived' = served from ClickHouse cold archive; 'events' = ClickHouse email_events. */
  source: 'hot' | 'archived' | 'events' | 'empty';
  rows: RecipientView[];
  /** Pass back as `cursor` to fetch the next page; null if exhausted. */
  nextCursor: string | null;
  /** Total count if cheaply available (PG dimensions only); null otherwise. */
  total: number | null;
}

export interface CampaignAnalytics {
  campaignId: string;
  totals: {
    recipients: number;
    sent: number;
    delivered: number;
    failed: number;
    /** Accepted by ACS but no delivery report yet (in-transit / deferred). */
    pending: number;
    uniqueOpens: number;
    uniqueClicks: number;
    bounces: number;
    complaints: number;
    unsubscribes: number;
  };
  rates: {
    delivery: number;
    uniqueOpen: number;
    uniqueClick: number;
    bounce: number;
    pending: number;
    complaint: number;
    unsubscribe: number;
  };
  funnel: Array<{ step: string; value: number; pct: number }>;
}
