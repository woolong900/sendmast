/**
 * Custom-tag substitution for outgoing emails.
 *
 * Placeholder syntax: `{{tag:<name>}}` (e.g. `{{tag:greeting}}`).
 * Names are case-insensitive on lookup; values are picked uniformly at
 * random from the tag's `values` array ONCE PER EMAIL: every occurrence of
 * the same tag in one message (subject, preheader and body alike) resolves
 * to the same value, while different recipients still get independent
 * picks. This matters for tags like `{{tag:domain}}` that appear in many
 * links — a single email must not send its logo, product and coupon
 * buttons to different shop domains. Callers share one `picks` map across
 * all fields of one message.
 *
 * Two render contexts:
 *   - `subject` / `preheader` are PLAIN TEXT in the email envelope; values
 *     are inserted verbatim (no escaping).
 *   - `html` body is HTML; values are HTML-escaped to prevent angle
 *     brackets in user-supplied tag values from breaking the markup or
 *     opening an XSS hole if a malicious tag value is configured.
 *
 * Unknown / undefined tags are left in place as-is. Surfaces the bug to
 * the user (they'll see `{{tag:foo}}` in the inbox) instead of silently
 * dropping the placeholder.
 */

export interface CustomTagDef {
  name: string;
  values: string[];
}

const TAG_RE = /\{\{tag:([a-z0-9_-]+)\}\}/gi;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Build a Map for O(1) lookup, lowercasing names so the placeholder match
 * is case-insensitive even though stored names are already lowercase.
 */
export function indexCustomTags(tags: CustomTagDef[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of tags) {
    if (t.values.length > 0) m.set(t.name.toLowerCase(), t.values);
  }
  return m;
}

/** Pick one value at random; assumes `values.length >= 1`. */
function pickRandom(values: string[]): string {
  // Math.random is fine here — this isn't security-sensitive and we want
  // the cheapest possible RNG since this runs per recipient.
  return values[Math.floor(Math.random() * values.length)];
}

/**
 * @param picks per-message memo (tag name → chosen value). Pass the SAME map
 *   for the subject, preheader and body of one email; create a new one per
 *   recipient.
 */
export function applyCustomTags(
  template: string,
  tags: Map<string, string[]>,
  ctx: 'text' | 'html',
  picks: Map<string, string>,
): string {
  // Empty fast path — most accounts won't have tags configured, and even
  // when they do, a particular field may not reference any.
  if (tags.size === 0) return template;
  return template.replace(TAG_RE, (match, name: string) => {
    const key = name.toLowerCase();
    const values = tags.get(key);
    if (!values) return match; // leave undefined tags visible
    let picked = picks.get(key);
    if (picked === undefined) {
      picked = pickRandom(values);
      picks.set(key, picked);
    }
    return ctx === 'html' ? escapeHtml(picked) : picked;
  });
}
