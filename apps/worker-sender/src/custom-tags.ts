/**
 * Custom-tag substitution for outgoing emails.
 *
 * Placeholder syntax: `{{tag:<name>}}` (e.g. `{{tag:greeting}}`).
 * Names are case-insensitive on lookup; values are picked uniformly at
 * random from the tag's `values` array, independently per render call —
 * so two recipients in the same campaign typically receive different
 * variants.
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
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
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

export function applyCustomTags(
  template: string,
  tags: Map<string, string[]>,
  ctx: 'text' | 'html',
): string {
  // Empty fast path — most accounts won't have tags configured, and even
  // when they do, a particular field may not reference any.
  if (tags.size === 0) return template;
  return template.replace(TAG_RE, (match, name: string) => {
    const values = tags.get(name.toLowerCase());
    if (!values) return match; // leave undefined tags visible
    const picked = pickRandom(values);
    return ctx === 'html' ? escapeHtml(picked) : picked;
  });
}
