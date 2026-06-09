import { createClient, type ClickHouseClient } from '@clickhouse/client';

// Re-export so consumers can type their own helpers without depending on
// @clickhouse/client directly.
export type { ClickHouseClient };

export interface ClickHouseConfig {
  url: string;
  database?: string;
  username?: string;
  password?: string;
}

let singleton: ClickHouseClient | undefined;

export function buildClickHouseClient(config: ClickHouseConfig): ClickHouseClient {
  return createClient({
    url: config.url,
    database: config.database ?? 'sendmast',
    username: config.username ?? 'default',
    password: config.password ?? '',
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
    },
  });
}

export function getClickHouseClient(): ClickHouseClient {
  if (!singleton) {
    singleton = buildClickHouseClient({
      url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
      database: process.env.CLICKHOUSE_DATABASE ?? 'sendmast',
      username: process.env.CLICKHOUSE_USER ?? 'default',
      password: process.env.CLICKHOUSE_PASSWORD ?? '',
    });
  }
  return singleton;
}

export type EmailEventType =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'open'
  | 'click'
  | 'bounce'
  | 'complaint'
  | 'unsubscribe'
  | 'failed';

/**
 * Subdivision of `event_type='bounce'` events:
 *   - 'hard'  : permanent failure (invalid address, suppressed, quarantined,
 *               5xx SMTP). These addresses should be added to the suppression
 *               list and never retried.
 *   - 'soft'    : transient failure (4xx SMTP). May eventually succeed if retried.
 *   - 'unknown' : bounce without a parseable 4xx/5xx code — sender-side policy /
 *                 reputation / DNS rejections (e.g. AUP#DNS) land here. NOT
 *                 suppressed and NOT counted as 无效邮箱: the recipient address
 *                 is probably fine; the fault is on our sending side.
 *   - ''        : non-bounce events (we use empty string instead of NULL to
 *                 keep the LowCardinality column dense).
 */
export type BounceKind = '' | 'hard' | 'soft';

export interface EmailEventRow {
  account_id: string;
  campaign_id: string;
  contact_id: string;
  recipient_id: string;
  event_type: EmailEventType;
  event_time: string;
  ip?: string | null;
  user_agent?: string | null;
  link_url?: string | null;
  raw_meta?: string | null;
  /** Only meaningful when event_type='bounce'; '' otherwise. */
  bounce_kind?: BounceKind;
}

export async function insertEmailEvents(
  client: ClickHouseClient,
  rows: EmailEventRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: 'sendmast.email_events',
    values: rows,
    format: 'JSONEachRow',
  });
}

// ---------------------------------------------------------------------------
// Shop orders / attributions (e-commerce integration)
// ---------------------------------------------------------------------------

/** Format an ISO/epoch instant for CH DateTime64 (space sep, no `Z`). */
export function toClickHouseDateTime(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

export interface OrderRow {
  account_id: string;
  shop_id: string;
  external_order_id: string;
  customer_email: string;
  /** Numeric string or number; CH Decimal(18,2). */
  value: number | string;
  currency: string;
  /** CH DateTime64 string (use toClickHouseDateTime). */
  order_time: string;
  attributed_campaign_id?: string | null;
  attributed_contact_id?: string | null;
  attribution_model?: string;
}

export async function insertOrders(
  client: ClickHouseClient,
  rows: OrderRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: 'sendmast.orders',
    values: rows,
    format: 'JSONEachRow',
  });
}

export interface AttributionRow {
  account_id: string;
  campaign_id: string;
  contact_id: string;
  /** CH DateTime64 string. */
  click_time: string;
  order_id: string;
  order_value: number | string;
  model?: string;
}

export async function insertAttributions(
  client: ClickHouseClient,
  rows: AttributionRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: 'sendmast.attributions',
    values: rows,
    format: 'JSONEachRow',
  });
}

/**
 * Last-click attribution: the most recent `click` event for `contactId` within
 * `withinDays`. Returns the campaign that earned the click, or null.
 */
export async function findLastClick(
  client: ClickHouseClient,
  opts: { accountId: string; contactId: string; withinDays: number },
): Promise<{ campaignId: string; clickTime: string } | null> {
  const r = await client.query({
    query: `SELECT campaign_id, event_time
            FROM sendmast.email_events
            WHERE account_id = {accountId:UUID}
              AND contact_id = {contactId:UUID}
              AND event_type = 'click'
              AND event_time >= now() - INTERVAL {days:UInt16} DAY
            ORDER BY event_time DESC
            LIMIT 1`,
    query_params: {
      accountId: opts.accountId,
      contactId: opts.contactId,
      days: opts.withinDays,
    },
    format: 'JSONEachRow',
  });
  const rows = (await r.json()) as Array<{ campaign_id: string; event_time: string }>;
  const row = rows[0];
  return row ? { campaignId: row.campaign_id, clickTime: row.event_time } : null;
}

export interface SalesAggregate {
  orders: number;
  revenue: number;
  currency: string;
}

/**
 * Revenue + order count attributed to a single campaign. `FINAL` collapses the
 * ReplacingMergeTree dupes so re-ingested orders aren't double-counted.
 */
export async function getCampaignSales(
  client: ClickHouseClient,
  campaignId: string,
): Promise<SalesAggregate> {
  const r = await client.query({
    query: `SELECT count() AS orders,
                   toFloat64(sum(value)) AS revenue,
                   any(currency) AS currency
            FROM sendmast.orders FINAL
            WHERE attributed_campaign_id = {campaignId:UUID}`,
    query_params: { campaignId },
    format: 'JSONEachRow',
  });
  const rows = (await r.json()) as Array<{ orders: number; revenue: number; currency: string }>;
  const row = rows[0];
  return {
    orders: Number(row?.orders ?? 0),
    revenue: Number(row?.revenue ?? 0),
    currency: row?.currency || 'USD',
  };
}

/**
 * Account-wide attributed sales over the last `sinceDays`. Counts only orders
 * with an attributed campaign (i.e. email-driven revenue).
 */
export async function getAccountSales(
  client: ClickHouseClient,
  opts: { accountId: string; sinceDays: number },
): Promise<SalesAggregate> {
  const r = await client.query({
    query: `SELECT count() AS orders,
                   toFloat64(sum(value)) AS revenue,
                   any(currency) AS currency
            FROM sendmast.orders FINAL
            WHERE account_id = {accountId:UUID}
              AND attributed_campaign_id IS NOT NULL
              AND order_time >= now() - INTERVAL {days:UInt16} DAY`,
    query_params: { accountId: opts.accountId, days: opts.sinceDays },
    format: 'JSONEachRow',
  });
  const rows = (await r.json()) as Array<{ orders: number; revenue: number; currency: string }>;
  const row = rows[0];
  return {
    orders: Number(row?.orders ?? 0),
    revenue: Number(row?.revenue ?? 0),
    currency: row?.currency || 'USD',
  };
}

// ---------------------------------------------------------------------------
// campaign_recipients_archive
// ---------------------------------------------------------------------------

export interface ArchivedRecipientRow {
  id: string;
  account_id: string;
  campaign_id: string;
  contact_id: string;
  email: string;
  /** 'sent' | 'failed' | 'canceled' (LowCardinality, but typed loose for forward-compat). */
  status: string;
  message_id: string | null;
  error_message: string | null;
  /** ISO-8601 string. */
  sent_at: string | null;
  /** ISO-8601 string. */
  created_at: string;
}

export async function insertArchivedRecipients(
  client: ClickHouseClient,
  rows: ArchivedRecipientRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({
    table: 'sendmast.campaign_recipients_archive',
    values: rows,
    format: 'JSONEachRow',
  });
}

/**
 * Look up a single archived recipient by id. Returns just enough fields for
 * worker-events to fill in `email_events` columns (accountId, campaignId,
 * contactId) when the corresponding PG row has been archived. Output shape
 * is camelCase so callers can use the same downstream code for hot/cold paths.
 */
export async function findArchivedRecipientById(
  client: ClickHouseClient,
  id: string,
): Promise<{
  id: string;
  accountId: string;
  campaignId: string;
  contactId: string;
} | null> {
  const r = await client.query({
    // Note: ORDER BY (account_id, campaign_id, id) — id alone is not the
    // primary key prefix, so this still triggers a partial scan. Good enough
    // for low-rate webhook fallbacks; if it ever becomes hot we can add a
    // skipping index on id.
    // FINAL collapses unmerged ReplacingMergeTree duplicates from partial
    // archive runs so a stale pre-merge row isn't picked for enrichment.
    query: `SELECT id, account_id, campaign_id, contact_id
            FROM sendmast.campaign_recipients_archive FINAL
            WHERE id = {id:UUID}
            LIMIT 1`,
    query_params: { id },
    format: 'JSONEachRow',
  });
  const rows = (await r.json()) as Array<{
    id: string;
    account_id: string;
    campaign_id: string;
    contact_id: string;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
  };
}
