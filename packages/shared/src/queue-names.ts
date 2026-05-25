export const QUEUE_NAMES = {
  IMPORT_CONTACTS: 'import-contacts',
  SEND_CAMPAIGN: 'send-campaign',
  SEND_EMAIL: 'send-email',
  SEND_TICK: 'send-tick',
  EVENTS_INGEST: 'events-ingest',
  SHOP_SYNC: 'shop-sync',
  /** Daily cron — archives terminal campaigns >= 90d old to ClickHouse. */
  ARCHIVE_RECIPIENTS: 'archive-recipients',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
