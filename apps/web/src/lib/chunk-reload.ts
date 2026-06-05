// After a deploy, an already-open tab still runs the PREVIOUS index.html, which
// references hashed chunk filenames (e.g. CampaignDetailPage-XXXX.js) that the
// new build pruned. Navigating to a lazy route then throws "Failed to fetch
// dynamically imported module". The fix is a one-time hard reload to fetch the
// fresh index.html + matching chunks.

const RELOAD_TS_KEY = 'sm:chunk-reload-ts';
// Cooldown so a genuine network failure (chunk really unreachable) can't spin
// the page in an infinite reload loop — we reload at most once per window.
const RELOAD_COOLDOWN_MS = 10_000;

/** True for the errors browsers throw when a lazy route chunk 404s after a deploy. */
export function isDynamicImportError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('Importing a module script failed')
  );
}

/**
 * Hard-reload the SPA once to recover from a stale-deploy chunk miss. Returns
 * true if a reload was actually triggered (false if we reloaded too recently,
 * which means the failure is probably real rather than a stale deploy).
 */
export function reloadForStaleChunkOnce(): boolean {
  const last = Number(sessionStorage.getItem(RELOAD_TS_KEY) || 0);
  if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
  sessionStorage.setItem(RELOAD_TS_KEY, String(Date.now()));
  window.location.reload();
  return true;
}
