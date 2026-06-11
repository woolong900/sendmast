export const QUEUE_NAMES = {
  IMPORT_CONTACTS: 'import-contacts',
  SEND_CAMPAIGN: 'send-campaign',
  SEND_EMAIL: 'send-email',
  SEND_TICK: 'send-tick',
  EVENTS_INGEST: 'events-ingest',
  /** Inbound shopyy webhook events (order paid/shipped, checkout abandoned). */
  SHOP_EVENTS: 'shop-events',
  /** Initial full store sync after bind (customers → list, paid orders). */
  SHOP_SYNC: 'shop-sync',
  /** Delayed abandoned-cart recovery sends (delay = automation.delayMinutes). */
  SHOP_ABANDONED: 'shop-abandoned',
  /** Daily cron — archives terminal campaigns >= 90d old to ClickHouse. */
  ARCHIVE_RECIPIENTS: 'archive-recipients',
  /** Server-side render of a campaign's HTML into a list thumbnail (WebP). */
  RENDER_THUMBNAIL: 'render-thumbnail',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
