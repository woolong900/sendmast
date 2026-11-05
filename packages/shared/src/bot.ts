/**
 * User agents of automated clients that open email links: mail security
 * scanners / link detonation sandboxes, link-preview fetchers, crawlers,
 * headless browsers and plain HTTP libraries. Used to flag (not drop) click
 * and storefront events so segments can ignore them.
 *
 * Deliberately NOT listed: Gmail/Yahoo image proxies (GoogleImageProxy,
 * YahooMailProxy) — they fetch open pixels on behalf of real readers.
 */
const BOT_UA_RE = new RegExp(
  [
    'bot\\b',
    'bot/',
    'crawl',
    'spider',
    'slurp',
    'preview',
    'headless',
    'phantomjs',
    'puppeteer',
    'playwright',
    'selenium',
    'lighthouse',
    'python-requests',
    'python-urllib',
    'aiohttp',
    'curl/',
    'wget/',
    'go-http-client',
    'java/',
    'okhttp',
    'axios/',
    'node-fetch',
    'undici',
    'libwww',
    'httpclient',
    'scanner',
    'barracuda',
    'mimecast',
    'proofpoint',
    'safelinks',
    'forcepoint',
    'ironport',
    'appriver',
    'existence discovery',
    'ms-office',
    'microsoft office',
  ].join('|'),
  'i',
);

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  return !!userAgent && BOT_UA_RE.test(userAgent);
}
