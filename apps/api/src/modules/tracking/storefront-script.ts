/**
 * Storefront behaviour script served at `/t/s/sdk.js?k=<siteKey>` and
 * embedded in the merchant's Shopyy store (OpenAPI install or manual paste).
 *
 * Scope (by product decision): ONLY visitors who arrived from one of our
 * emails are tracked. Every email link carries `sm_mid=<send id>`; the script
 * persists it in a first-party cookie + localStorage for 30 days and stays
 * completely silent for everyone else (no cookie, no request).
 *
 * Event sources, de-duplicated client-side (same event type within 3s):
 *   1. Page classification by URL (home / collection / product / cart /
 *      checkout / thank-you), re-run on SPA navigations.
 *   2. Cart / payment XHR + fetch calls made by the storefront theme.
 *   3. GA4 ecommerce events the store already pushes to `dataLayer`
 *      (gtag / GTM) — the most reliable source when configured. We only
 *      observe the push and always call through; the Meta Pixel (fbq) is
 *      deliberately NOT wrapped because replacing its stub can break the
 *      merchant's ad conversion tracking.
 *   4. `window.SendMast.track(type, data)` for custom theme code.
 * `purchase` is also written server-side from order webhooks, so the
 * thank-you page detection is a best-effort extra, not the source of truth.
 *
 * Bot filtering (mail security scanners often open email links in a
 * headless browser, carrying the recipient's sm_mid):
 *   - automation (navigator.webdriver) / headless or bot user agents → the
 *     script stays silent;
 *   - page-load events (views, checkout/thank-you page visits) are held back
 *     until a human signal — scroll, pointer/mouse movement, touch, key —
 *     and dropped if the page is left without one. The signal is remembered
 *     for the browser session. Action events (add_to_cart, add_payment_info)
 *     imply a user action and go out immediately.
 *   - the server additionally flags bot user agents (is_bot) and segments
 *     ignore flagged rows.
 *
 * Kept as dependency-free ES5 so it runs on any theme without a build step.
 */
export function buildStorefrontScript(opts: { endpoint: string; key: string }): string {
  return `/* SendMast storefront tracking */
(function () {
  'use strict';
  if (window.__sendmastSite) return;
  window.__sendmastSite = true;

  var KEY = ${JSON.stringify(opts.key)};
  var ENDPOINT = ${JSON.stringify(opts.endpoint)};
  var MID = '_sm_mid', SID = '_sm_sid', TTL_MS = 30 * 864e5;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function param(name) {
    try { return new URL(location.href).searchParams.get(name); } catch (e) { return null; }
  }
  function getCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(n, v, ms) {
    document.cookie = n + '=' + encodeURIComponent(v) + '; path=/; max-age=' + Math.floor(ms / 1000) +
      '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }
  function store(k, v) {
    try {
      if (v === undefined) return window.localStorage.getItem(k);
      window.localStorage.setItem(k, v);
    } catch (e) { return null; }
  }

  // ---- identity: a fresh email click (URL) always wins over stored ids ----
  var mid = param('sm_mid');
  if (mid && UUID_RE.test(mid)) {
    setCookie(MID, mid, TTL_MS);
    store(MID, JSON.stringify({ id: mid, exp: Date.now() + TTL_MS }));
  } else {
    mid = getCookie(MID);
    if (!mid) {
      try {
        var saved = JSON.parse(store(MID) || 'null');
        if (saved && saved.exp > Date.now() && UUID_RE.test(saved.id)) mid = saved.id;
      } catch (e) { mid = null; }
    }
  }
  if (!mid || !UUID_RE.test(mid)) {
    window.SendMast = { track: function () {} };
    return; // not an email visitor — stay silent
  }
  var ua = navigator.userAgent || '';
  if (navigator.webdriver ||
      /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Lighthouse|bot\b|crawl|spider|preview/i.test(ua)) {
    window.SendMast = { track: function () {} };
    return; // automated browser (mail security scanner, crawler) — never report
  }

  var sid = null;
  try { sid = window.sessionStorage.getItem(SID); } catch (e) {}
  if (!sid) {
    sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    try { window.sessionStorage.setItem(SID, sid); } catch (e) {}
  }

  // ---- human gate ----
  var HUMAN = '_sm_h';
  var human = false;
  try { human = window.sessionStorage.getItem(HUMAN) === '1'; } catch (e) {}
  var pending = [];
  var ACTION_TYPES = { add_to_cart: 1, add_payment_info: 1 };
  function markHuman() {
    if (human) return;
    human = true;
    try { window.sessionStorage.setItem(HUMAN, '1'); } catch (e) {}
    for (var i = 0; i < SIGNALS.length; i++) {
      window.removeEventListener(SIGNALS[i], onSignal, true);
    }
    if (pending.length) {
      queue = queue.concat(pending);
      pending = [];
      if (!timer) timer = setTimeout(flush, 1000);
    }
  }
  var SIGNALS = ['scroll', 'wheel', 'mousemove', 'pointerdown', 'touchstart', 'keydown'];
  var moved = 0;
  function onSignal(e) {
    if (!e || e.isTrusted === false) return; // ignore script-dispatched events
    if (e.type === 'mousemove') {
      // Browsers fire a trusted zero-movement mousemove on load/layout
      // changes; require real pointer travel.
      moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
      if (moved < 10) return;
    } else if (e.type === 'scroll') {
      if ((window.scrollY || window.pageYOffset || 0) < 20) return; // scroll restoration / anchoring
    }
    markHuman();
  }
  if (!human) {
    for (var si = 0; si < SIGNALS.length; si++) {
      window.addEventListener(SIGNALS[si], onSignal, { capture: true, passive: true });
    }
  }

  // ---- batching transport ----
  var queue = [], timer = null, recent = {};
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    while (queue.length) {
      var body = JSON.stringify({ k: KEY, mid: mid, sid: sid, e: queue.splice(0, 20) });
      var sent = false;
      try {
        if (navigator.sendBeacon) sent = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }));
      } catch (e) {}
      if (!sent) {
        try {
          fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' } });
        } catch (e) {}
      }
    }
  }
  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && isFinite(n) && n >= 0 ? n : undefined;
  }
  function track(type, data) {
    data = data || {};
    var pid = data.productId != null ? String(data.productId).slice(0, 200) : undefined;
    // Same event type within 3s = one action seen by several sources (URL,
    // network hook, GA4 push) — keep the first, don't inflate counts.
    var dedupe = type + '|' + (data.orderId || '');
    var now = Date.now();
    if (recent[dedupe] && now - recent[dedupe] < 3000) return;
    recent[dedupe] = now;
    var ev = { t: type, ts: now, u: location.href.slice(0, 2000) };
    if (pid) ev.p = pid;
    var v = num(data.value);
    if (v !== undefined) ev.v = v;
    if (data.currency) ev.c = String(data.currency).slice(0, 10);
    if (data.orderId) ev.m = { order: String(data.orderId).slice(0, 200) };
    if (ACTION_TYPES[type]) markHuman(); // a cart/payment action is a human signal
    if (!human) {
      pending.push(ev); // held until a human signal; dropped if the page is left
      return;
    }
    queue.push(ev);
    if (queue.length >= 10) flush();
    else if (!timer) timer = setTimeout(flush, 1000);
  }
  window.SendMast = { track: track };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });

  // ---- 1. page classification ----
  function meta(prop) {
    var el = document.querySelector('meta[property="' + prop + '"],meta[name="' + prop + '"]');
    return el ? el.getAttribute('content') : null;
  }
  function classify() {
    var p = (location.pathname || '/').toLowerCase().replace(/\\/+$/, '') || '/';
    p = p.replace(/^\\/[a-z]{2}(-[a-z]{2})?(?=\\/|$)/, '') || '/'; // strip /en, /fr-fr …
    if (/(thank[-_]?you|order[-_]?success|pay(ment)?[-_]?success|\\/success$|\\/complete$)/.test(p) &&
        /(checkout|order|pay|thank)/.test(p)) return 'purchase';
    if (/\\/checkouts?(\\/|$)/.test(p)) return 'begin_checkout';
    if (/\\/cart(\\/|$)/.test(p)) return 'view_cart';
    if (/\\/(products?|goods|item)\\//.test(p) || meta('og:type') === 'product') return 'view_product';
    if (/\\/(collections?|categor(y|ies)|search)(\\/|$)/.test(p)) return 'view_collection';
    if (p === '/' || p === '/index' || p === '/index.html') return 'view_home';
    return null;
  }
  var onceKeys = {};
  function once(key) {
    if (onceKeys[key]) return false;
    onceKeys[key] = true;
    try {
      var k = '_sm_once_' + key;
      if (window.sessionStorage.getItem(k)) return false;
      window.sessionStorage.setItem(k, '1');
    } catch (e) {}
    return true;
  }
  var lastPath = null;
  function onPage() {
    if (location.pathname + location.search === lastPath) return;
    lastPath = location.pathname + location.search;
    track('page_view');
    var type = classify();
    if (!type) return;
    if (type === 'view_product') {
      track('view_product', {
        productId: meta('product:retailer_item_id') || meta('og:url') || location.pathname,
        value: meta('product:price:amount') || meta('og:price:amount'),
        currency: meta('product:price:currency') || meta('og:price:currency'),
      });
    } else if (type === 'begin_checkout') {
      if (once('bc_' + location.pathname)) track('begin_checkout');
    } else if (type === 'purchase') {
      if (once('pu_' + location.pathname + location.search)) track('purchase');
    } else {
      track(type);
    }
  }
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    if (typeof orig !== 'function') return;
    history[fn] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(onPage, 0);
      return r;
    };
  });
  window.addEventListener('popstate', function () { setTimeout(onPage, 0); });

  // ---- 2. theme network calls ----
  var NET_RULES = [
    [/(\\/cart\\/(add|create|items?)\\b|\\/carts?\\/add|add[-_]?to[-_]?cart|\\/cart\\/?$)/i, 'add_to_cart'],
    [/(payment[-_]?(info|method)|\\/pay(ment)?\\/(submit|create|prepare|save)|\\/checkouts?\\/.*\\/pay(ment)?\\b)/i, 'add_payment_info'],
  ];
  function netType(method, url) {
    if (!url || String(url).indexOf(ENDPOINT) === 0) return null;
    if (!/^(POST|PUT|PATCH)$/i.test(method || 'GET')) return null;
    for (var i = 0; i < NET_RULES.length; i++) if (NET_RULES[i][0].test(String(url))) return NET_RULES[i][1];
    return null;
  }
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url;
      var method = (init && init.method) || (input && input.method) || 'GET';
      var type = netType(method, url);
      var p = origFetch.apply(this, arguments);
      if (type) p.then(function (res) { if (res && res.ok) track(type); }, function () {});
      return p;
    };
  }
  if (window.XMLHttpRequest) {
    var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__smType = netType(method, url);
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      if (xhr.__smType) xhr.addEventListener('load', function () {
        if (xhr.status >= 200 && xhr.status < 400) track(xhr.__smType);
      });
      return xs.apply(this, arguments);
    };
  }

  // ---- 3. standard pixels the store already fires ----
  var GA4 = { view_item: 'view_product', view_item_list: 'view_collection', view_cart: 'view_cart',
    add_to_cart: 'add_to_cart', begin_checkout: 'begin_checkout', add_payment_info: 'add_payment_info',
    purchase: 'purchase' };
  function firstItemId(p) {
    var it = p && p.items && p.items[0];
    return it ? it.item_id || it.id : undefined;
  }
  function fromGa(name, p) {
    var type = GA4[name];
    if (!type) return;
    p = p || {};
    track(type, { productId: firstItemId(p), value: p.value, currency: p.currency, orderId: p.transaction_id });
  }
  function onDataLayer(item) {
    if (!item) return;
    if (typeof item.length === 'number' && item[0] === 'event') fromGa(item[1], item[2]); // gtag()
    else if (item.event) fromGa(item.event, item.ecommerce || item); // GTM push
  }
  // gtag.js replaces dataLayer.push with its own processor when it loads, so
  // (re-)wrap whatever push is current for the first ~15s. Our wrapper only
  // observes and always calls through to the current implementation.
  function wrapDataLayer() {
    var dl = (window.dataLayer = window.dataLayer || []);
    if (dl.push && dl.push.__sm) return;
    var inner = dl.push;
    var wrapped = function () {
      for (var i = 0; i < arguments.length; i++) { try { onDataLayer(arguments[i]); } catch (e) {} }
      return inner.apply(dl, arguments);
    };
    wrapped.__sm = true;
    dl.push = wrapped;
  }
  var tries = 0;
  (function poll() { wrapDataLayer(); if (++tries < 30) setTimeout(poll, 500); })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onPage);
  else onPage();
})();
`;
}
