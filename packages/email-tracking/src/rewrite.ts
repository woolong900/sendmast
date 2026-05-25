import { signTrackingToken } from './token.js';

export interface UtmParams {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
}

export interface RewriteOptions {
  baseUrl: string;
  secret: string;
  recipientId: string;
  /** When set, utm_source/utm_medium/utm_campaign are appended to each tracked URL. */
  utm?: UtmParams;
  /**
   * When false, hrefs are NOT wrapped in /t/c/{token}?u=... so click events
   * won't be recorded. UTM params are still applied to the original URL so
   * downstream analytics (GA, etc.) keep working. Defaults to true.
   */
  trackClicks?: boolean;
}

export interface RewriteResult {
  html: string;
  links: Array<{ index: number; url: string }>;
}

const HREF_REGEX = /href=("|')([^"']+)("|')/gi;

function applyUtm(url: string, utm?: UtmParams): string {
  if (!utm) return url;
  if (!utm.source && !utm.medium && !utm.campaign) return url;
  try {
    const u = new URL(url);
    if (utm.source && !u.searchParams.has('utm_source')) u.searchParams.set('utm_source', utm.source);
    if (utm.medium && !u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', utm.medium);
    if (utm.campaign && !u.searchParams.has('utm_campaign'))
      u.searchParams.set('utm_campaign', utm.campaign);
    return u.toString();
  } catch {
    return url;
  }
}

/** Wrap http(s) hrefs in /t/c/{token}?u=ENC(url). Adds {pixel} at the body end. */
export function rewriteHtml(html: string, opts: RewriteOptions): RewriteResult {
  const links: Array<{ index: number; url: string }> = [];
  const trackClicks = opts.trackClicks !== false;
  let i = 0;

  const rewritten = html.replace(HREF_REGEX, (match, q1: string, url: string) => {
    if (!/^https?:\/\//i.test(url)) return match;
    if (url.includes('{{unsubscribe_url}}')) return match;
    const finalUrl = applyUtm(url, opts.utm);
    // Click tracking off → write the (UTM-tagged) URL straight back so the
    // user lands on the destination directly, with no /t/c redirect and no
    // token issued. UTM still goes through because that's the destination's
    // own analytics, independent of our open/click pipeline.
    if (!trackClicks) {
      return finalUrl === url ? match : `href=${q1}${finalUrl}${q1}`;
    }
    const idx = i++;
    links.push({ index: idx, url: finalUrl });
    const token = signTrackingToken({ r: opts.recipientId, k: 'c', i: idx }, opts.secret);
    const wrapped = `${opts.baseUrl.replace(/\/$/, '')}/t/c/${token}?u=${encodeURIComponent(finalUrl)}`;
    return `href=${q1}${wrapped}${q1}`;
  });

  const openToken = signTrackingToken({ r: opts.recipientId, k: 'o' }, opts.secret);
  const pixel = `<img src="${opts.baseUrl.replace(/\/$/, '')}/t/o/${openToken}.gif" width="1" height="1" alt="" style="display:block;border:0" />`;

  const unsubToken = signTrackingToken({ r: opts.recipientId, k: 'u' }, opts.secret);
  const unsubUrl = `${opts.baseUrl.replace(/\/$/, '')}/t/u/${unsubToken}`;

  let final = rewritten.replace(/{{unsubscribe_url}}/g, unsubUrl);

  if (final.includes('</body>')) {
    final = final.replace('</body>', `${pixel}</body>`);
  } else {
    final = `${final}${pixel}`;
  }

  return { html: final, links };
}
