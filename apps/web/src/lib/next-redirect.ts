/**
 * Post-auth redirect target carried as a `?next=` query param (instead of
 * router state, which only survives in-SPA navigation). A query param rides in
 * the URL itself, so it also survives a fresh navigation — new tab, bookmark,
 * shared link, or a manually-typed address — which is what the Shopyy authorize
 * callback needs when the merchant isn't logged in yet.
 */

/**
 * Accept only internal absolute paths. Rejects anything that could send the
 * user off-site after login (open-redirect): absolute URLs, protocol-relative
 * `//host`, and backslash variants browsers may normalise to `//`.
 */
export function sanitizeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
}

/** Append `?next=<encoded>` to an auth route, omitting it when there's no target. */
export function withNext(path: string, next: string | null): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}
