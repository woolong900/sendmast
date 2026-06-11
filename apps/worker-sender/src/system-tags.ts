/**
 * System-tag substitution for outgoing emails.
 *
 * Whitelisted double-brace placeholders like `{{first_name}}`, `{{email}}`,
 * `{{unsubscribe_url}}`. The regex strictly matches only the names defined
 * in `SYSTEM_TAG_NAMES`, so any other `{{xxx}}` text in the body is left
 * untouched — including `{{tag:...}}` placeholders, which the custom-tag
 * pass handles separately.
 *
 * Render contexts:
 *   - `text`: subject / preheader. Insert verbatim.
 *   - `html`: body. HTML-escape so contact-supplied first/last names with
 *     angle brackets can't break markup or open an XSS hole. The
 *     `{{unsubscribe_url}}` value also goes through escapeHtml because
 *     it's typically dropped into an `<a href="...">` attribute, where
 *     `&` and `"` need encoding too.
 */

import {
  SYSTEM_TAG_NAMES,
  MERGE_VAR_TAG_NAMES,
  HTML_MERGE_VAR_TAG_NAMES,
} from '@sendmast/shared';

export interface SystemTagContext {
  contact: {
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
  campaign: {
    id: string;
    name: string;
    fromEmail: string;
  };
  /** Target list name(s) for this campaign, joined by 「、」. Empty for segment-only sends. */
  listName: string;
  unsubscribeUrl: string;
  /**
   * Per-recipient merge values for transactional automation sends, keyed by
   * system-tag name (e.g. order_total, tracking_url). Undefined for ordinary
   * bulk-campaign recipients.
   */
  mergeVars?: Record<string, string> | null;
}

// Built dynamically from the shared whitelist so adding a new system tag
// in @sendmast/shared automatically widens the regex without touching
// this file. The outer group captures the name.
const SYS_TAG_RE = new RegExp(`\\{\\{(${SYSTEM_TAG_NAMES.join('|')})\\}\\}`, 'g');

// Tags whose value may legitimately be empty — substitute to '' rather than
// leaving the visible placeholder. Names: contacts often have no first/last
// name; list_name is empty for segment-only sends.
const MAY_BE_EMPTY = new Set([
  'first_name',
  'last_name',
  'full_name',
  'list_name',
  // Merge-var tags are blank on ordinary bulk campaigns; render to '' rather
  // than leaving a visible {{order_total}} placeholder in the inbox.
  ...MERGE_VAR_TAG_NAMES,
  ...HTML_MERGE_VAR_TAG_NAMES,
]);

// Both escaped and html-fragment merge vars resolve from ctx.mergeVars.
const MERGE_VAR_NAME_SET = new Set<string>([
  ...MERGE_VAR_TAG_NAMES,
  ...HTML_MERGE_VAR_TAG_NAMES,
]);

// Merge vars whose value is a pre-rendered, trusted HTML fragment — injected
// verbatim (the renderer already escaped its dynamic text). Escaping these
// would turn the markup into literal text in the inbox.
const HTML_MERGE_NAME_SET = new Set<string>(HTML_MERGE_VAR_TAG_NAMES);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function fullName(c: SystemTagContext['contact']): string {
  const fn = (c.firstName ?? '').trim();
  const ln = (c.lastName ?? '').trim();
  if (fn && ln) return `${fn} ${ln}`;
  if (fn) return fn;
  if (ln) return ln;
  // Fallback to email local part — keeps salutations like "Hi {full_name}"
  // from rendering as "Hi ," for contacts with no name on file.
  return c.email.split('@')[0] ?? '';
}

function resolve(name: string, ctx: SystemTagContext): string {
  if (MERGE_VAR_NAME_SET.has(name)) {
    return (ctx.mergeVars?.[name] ?? '').trim();
  }
  switch (name) {
    case 'first_name':
      return (ctx.contact.firstName ?? '').trim();
    case 'last_name':
      return (ctx.contact.lastName ?? '').trim();
    case 'full_name':
      return fullName(ctx.contact);
    case 'email':
      return ctx.contact.email;
    case 'campaign_id':
      return ctx.campaign.id;
    case 'campaign_name':
      return ctx.campaign.name;
    case 'list_name':
      return ctx.listName;
    case 'date': {
      const now = new Date();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      return `${mm}${dd}`;
    }
    case 'sender_domain':
      return (ctx.campaign.fromEmail.split('@')[1] ?? '').toLowerCase();
    case 'unsubscribe_url':
      return ctx.unsubscribeUrl;
    default:
      return '';
  }
}

export function applySystemTags(
  template: string,
  ctx: SystemTagContext,
  renderCtx: 'text' | 'html',
): string {
  return template.replace(SYS_TAG_RE, (match, name: string) => {
    const v = resolve(name, ctx);
    if (v === '' && !MAY_BE_EMPTY.has(name)) {
      // For tags that must always resolve, an empty value means a programming
      // bug (regex matched a name we don't handle) — leave the placeholder in
      // place so it's visible in the inbox rather than silently disappearing.
      return match;
    }
    // Pre-rendered HTML fragments (e.g. order_items) go in untouched; their
    // dynamic text was escaped at render time. Everything else is escaped in
    // html context to keep contact-supplied values from breaking markup.
    if (HTML_MERGE_NAME_SET.has(name)) return v;
    return renderCtx === 'html' ? escapeHtml(v) : v;
  });
}

// Auto-appended unsubscribe footer. Visible body unsubscribe links are
// CAN-SPAM compliance: regulators require recipients can opt out without
// hunting through email headers. The platform also writes a
// `List-Unsubscribe` RFC 8058 header for one-click clients, but a visible
// link is the user-facing fallback.
//
// Mirrors the visual design of the editor's "底部退订" palette block —
// centered, muted gray, 12px. Built as a `<table>` (not a `<div>`) for
// Outlook/Gmail-app reliability: those clients drop or restyle CSS on
// arbitrary block elements but always render `<table>` faithfully.
const DEFAULT_UNSUBSCRIBE_FOOTER = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="100%" style="border-collapse:collapse;">
<tr><td align="center" style="padding:24px;color:#9ca3af;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;">You received this email because you subscribed to our updates.<br/>Don't want to receive these anymore? <a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></td></tr>
</table>`;

const UNSUB_PLACEHOLDER_RE = /\{\{unsubscribe_url\}\}/;

/**
 * If the body already contains `{{unsubscribe_url}}` anywhere, return it
 * unchanged — the user has placed their own unsubscribe link (typically via
 * the "底部退订" palette block, but a hand-typed `<a href="{{unsubscribe_url}}">`
 * works too). Otherwise inject a default footer just before `</body>` (or
 * append if there's no body tag, e.g. a fragment template). The footer's
 * `{{unsubscribe_url}}` is then resolved by the regular system-tag pass —
 * single substitution path, single source of truth.
 *
 * Detection deliberately mirrors the substitution regex (no whitespace
 * tolerance): if the user typed `{{ unsubscribe_url }}` with stray spaces,
 * the substitution wouldn't replace it either, so detecting the malformed
 * form would just produce a duplicated footer. Better to require correct
 * placeholder spelling for the opt-out signal.
 */
export function ensureUnsubscribeFooter(html: string): string {
  if (UNSUB_PLACEHOLDER_RE.test(html)) return html;
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + DEFAULT_UNSUBSCRIBE_FOOTER;
  return html.slice(0, idx) + DEFAULT_UNSUBSCRIBE_FOOTER + html.slice(idx);
}

/**
 * Inject inbox preview text (preheader) as a hidden block at the very top of the
 * body. Email clients surface the first visible text as the preview snippet;
 * the trailing zero-width/non-breaking spacers push the real content out of the
 * preview so it isn't appended. `text` must already be tag-resolved + plain.
 */
export function injectPreheader(html: string, text: string): string {
  const t = text.trim();
  if (!t) return html;
  const esc = t.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
  // Spacer fills the inbox preview window so body text isn't appended after the
  // preview snippet. Each unit is a non-collapsing space (zero-width joiners
  // stop clients merging the nbsp run); ~150 units comfortably covers the
  // longest preview widths (Gmail ~100 chars, Apple Mail/Outlook longer).
  const spacer = '&#847;&zwnj;&nbsp;'.repeat(150);
  const span =
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;` +
    `font-size:1px;line-height:1px;color:#ffffff;opacity:0;">${esc}${spacer}</div>`;
  const m = html.match(/<body[^>]*>/i);
  if (m) return html.replace(m[0], `${m[0]}${span}`);
  return span + html;
}
