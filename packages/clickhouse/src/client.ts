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
 *   - 'soft'  : transient failure (4xx SMTP, mailbox full, server temporary
 *               unavailable). These may eventually succeed if retried.
 *   - ''      : non-bounce events (we use empty string instead of NULL to
 *               keep the LowCardinality column dense).
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
    query: `SELECT id, account_id, campaign_id, contact_id
            FROM sendmast.campaign_recipients_archive
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
