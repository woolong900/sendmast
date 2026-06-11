import { z } from 'zod';
import { SubscriptionStatusSchema } from './contact.js';

/**
 * Dynamic-audience definition. A flat list of rules joined by a single
 * top-level `op` (v1: AND only — users who need OR build separate segments).
 *
 * Versioned via `v` so future schema bumps (nested groups, custom contact
 * fields, order-based rules) don't break stored definitions.
 */

const Uuid = z.string().uuid();

// ---------- Rule shapes ----------

/** Whitelisted contact-table columns the user may filter on. */
const AttributeFieldSchema = z.enum([
  'country',
  'state',
  'city',
  'language',
  'gender',
]);
export type AttributeField = z.infer<typeof AttributeFieldSchema>;

// NOTE: each rule branch is a plain z.object (no discriminatedUnion nesting,
// no .refine()) so we can z.union them together. zod v3 forbids both nested
// discriminated unions and ZodEffects members inside a discriminated union;
// the cost of plain union is slightly worse error pin-pointing, acceptable
// at our rule-count limit (max 20 per segment).

const AttributeRuleScalar = z.object({
  type: z.literal('attribute'),
  field: AttributeFieldSchema,
  op: z.enum(['eq', 'neq']),
  value: z.string().min(1).max(120),
});
const AttributeRuleList = z.object({
  type: z.literal('attribute'),
  field: AttributeFieldSchema,
  op: z.enum(['in', 'notIn']),
  value: z.array(z.string().min(1).max(120)).min(1).max(100),
});

const SubscriptionRule = z.object({
  type: z.literal('subscription'),
  op: z.literal('eq'),
  value: SubscriptionStatusSchema,
});

const ListRule = z.object({
  type: z.literal('list'),
  op: z.enum(['memberOf', 'notMemberOf']),
  values: z.array(Uuid).min(1).max(50),
});

const TagRule = z.object({
  type: z.literal('tag'),
  op: z.enum(['hasAny', 'hasAll', 'notHasAny']),
  values: z.array(Uuid).min(1).max(50),
});

const CreatedAtBetween = z
  .object({
    type: z.literal('createdAt'),
    op: z.literal('between'),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .refine((v) => !!(v.from || v.to), {
    message: 'createdAt.between requires at least one of from / to',
  });
const CreatedAtLastDays = z.object({
  type: z.literal('createdAt'),
  op: z.literal('lastDays'),
  days: z.number().int().min(1).max(3650),
});

const EventRule = z.object({
  type: z.literal('event'),
  // v1: opens + clicks only. bounce/unsubscribe filtering is rarely a
  // segmentation use-case (handled by subscriptionStatus + suppression list).
  event: z.enum(['open', 'click']),
  op: z.enum(['has', 'notHas']),
  /** Specific campaign or undefined for "any campaign". */
  campaignId: Uuid.optional(),
  /** Look-back window in days. */
  lastDays: z.number().int().min(1).max(3650),
});

/**
 * Matched against shop_orders (paid/shipped) ingested from connected stores —
 * "has placed a paid order". Backfilled on store bind, kept current by the
 * order webhooks.
 */
const OrderRule = z.object({
  type: z.literal('order'),
  op: z.enum(['has', 'notHas']),
  /** Look-back window in days; absent = any time. */
  lastDays: z.number().int().min(1).max(3650).optional(),
});

export const SegmentRuleSchema = z.union([
  AttributeRuleScalar,
  AttributeRuleList,
  SubscriptionRule,
  ListRule,
  TagRule,
  CreatedAtBetween,
  CreatedAtLastDays,
  EventRule,
  OrderRule,
]);
export type SegmentRule = z.infer<typeof SegmentRuleSchema>;

// ---------- Definition wrapper ----------

export const SegmentDefinitionSchema = z.object({
  v: z.literal(1),
  op: z.literal('AND'),
  rules: z.array(SegmentRuleSchema).min(1).max(20),
});
export type SegmentDefinition = z.infer<typeof SegmentDefinitionSchema>;

// ---------- CRUD ----------

export const CreateSegmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  definition: SegmentDefinitionSchema,
});
export type CreateSegmentInput = z.infer<typeof CreateSegmentSchema>;

export const UpdateSegmentSchema = CreateSegmentSchema.partial();
export type UpdateSegmentInput = z.infer<typeof UpdateSegmentSchema>;

export const PreviewSegmentSchema = z.object({
  definition: SegmentDefinitionSchema,
});
export type PreviewSegmentInput = z.infer<typeof PreviewSegmentSchema>;

export const ListSegmentContactsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSegmentContactsQuery = z.infer<typeof ListSegmentContactsQuerySchema>;

// ---------- Response views ----------

export interface SegmentView {
  id: string;
  name: string;
  description: string | null;
  definition: SegmentDefinition;
  cachedCount: number | null;
  cachedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentPreviewResult {
  count: number;
  sample: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  }>;
}

export interface SegmentContactsPage {
  items: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    subscriptionStatus: string;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}
