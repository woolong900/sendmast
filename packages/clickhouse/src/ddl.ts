export const DDL_STATEMENTS: string[] = [
  `CREATE DATABASE IF NOT EXISTS sendmast`,

  `CREATE TABLE IF NOT EXISTS sendmast.email_events (
      account_id     UUID,
      campaign_id    UUID,
      contact_id     UUID,
      recipient_id   UUID,
      event_type     LowCardinality(String),
      event_time     DateTime64(3, 'UTC'),
      ip             Nullable(IPv6),
      user_agent     Nullable(String),
      link_url       Nullable(String),
      raw_meta       Nullable(String) CODEC(ZSTD(3)),
      bounce_kind    LowCardinality(String) DEFAULT '',
      source_type    LowCardinality(String) DEFAULT 'campaign',
      source_id      Nullable(UUID)
   )
   ENGINE = MergeTree
   PARTITION BY toYYYYMM(event_time)
   ORDER BY (account_id, campaign_id, event_time, event_type)
   TTL toDateTime(event_time) + INTERVAL 24 MONTH DELETE
   SETTINGS index_granularity = 8192`,

  // Idempotent migration for installs that pre-date the bounce_kind column.
  // ClickHouse's ALTER ADD COLUMN IF NOT EXISTS is the safe form; runs in
  // O(1) since LowCardinality with DEFAULT '' doesn't rewrite any data.
  `ALTER TABLE sendmast.email_events ADD COLUMN IF NOT EXISTS bounce_kind LowCardinality(String) DEFAULT ''`,

  // Klaviyo-style flow sends share email_events with campaigns. `source_type`
  // separates campaign vs flow analytics; `source_id` is the automation/flow id
  // for flow events (NULL for campaigns). campaign_id stays the zero-UUID for
  // flow rows so the existing ORDER BY prefix is unaffected.
  `ALTER TABLE sendmast.email_events ADD COLUMN IF NOT EXISTS source_type LowCardinality(String) DEFAULT 'campaign'`,
  `ALTER TABLE sendmast.email_events ADD COLUMN IF NOT EXISTS source_id Nullable(UUID)`,

  `CREATE TABLE IF NOT EXISTS sendmast.orders (
      account_id              UUID,
      shop_id                 UUID,
      external_order_id       String,
      customer_email          String,
      value                   Decimal(18, 2),
      currency                LowCardinality(String),
      order_time              DateTime64(3, 'UTC'),
      attributed_campaign_id  Nullable(UUID),
      attributed_contact_id   Nullable(UUID),
      attribution_model       LowCardinality(String) DEFAULT '',
      ingested_at             DateTime DEFAULT now()
   )
   ENGINE = ReplacingMergeTree(ingested_at)
   PARTITION BY toYYYYMM(order_time)
   ORDER BY (account_id, shop_id, external_order_id)
   SETTINGS index_granularity = 8192`,

  // Cold-storage archive of campaign_recipients rows. Populated by the
  // archive cron once a campaign is fully terminal (sent / canceled / failed)
  // AND >= 90 days old, then deleted from PG.
  //
  // ReplacingMergeTree ordered by (account_id, campaign_id, id) means: if
  // the archive worker is killed mid-batch and re-runs, duplicate inserts
  // for the same recipient `id` automatically dedupe at merge time (keeping
  // the row with the latest `archived_at`). Pre-merge queries may transiently
  // see dupes — readers that need strict uniqueness should use `... FINAL`.
  `CREATE TABLE IF NOT EXISTS sendmast.campaign_recipients_archive (
      id            UUID,
      account_id    UUID,
      campaign_id   UUID,
      contact_id    UUID,
      email         String,
      status        LowCardinality(String),
      message_id    Nullable(String),
      error_message Nullable(String),
      sent_at       Nullable(DateTime64(3, 'UTC')),
      created_at    DateTime64(3, 'UTC'),
      archived_at   DateTime DEFAULT now()
   )
   ENGINE = ReplacingMergeTree(archived_at)
   PARTITION BY toYYYYMM(created_at)
   ORDER BY (account_id, campaign_id, id)
   SETTINGS index_granularity = 8192`,

  `CREATE TABLE IF NOT EXISTS sendmast.attributions (
      account_id     UUID,
      campaign_id    UUID,
      contact_id     UUID,
      click_time     DateTime64(3, 'UTC'),
      order_id       String,
      order_value    Decimal(18, 2),
      model          LowCardinality(String) DEFAULT 'last_click_7d',
      created_at     DateTime DEFAULT now()
   )
   ENGINE = MergeTree
   PARTITION BY toYYYYMM(click_time)
   ORDER BY (account_id, campaign_id, contact_id, click_time)`,
];
