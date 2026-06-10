import ReactDOM from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reloadForStaleChunkOnce } from './lib/chunk-reload';
import { useAuth } from './store/auth';
import './index.css';

// Vite fires this when a lazy route's chunk fails to load — typically because a
// new deploy pruned the hashed filenames this (now stale) tab still references.
// One hard reload pulls the fresh index.html + chunks.
window.addEventListener('vite:preloadError', () => {
  reloadForStaleChunkOnce();
});

const queryClient = new QueryClient({
  defaultOptions: {
    // Users are far from the origin (US) over a high-RTT link — each round trip
    // costs ~1s warm / ~3s cold. A longer staleTime lets in-session navigation
    // reuse cached data instead of re-paying that latency on every page mount;
    // mutations still invalidate explicitly, so freshness on writes is intact.
    queries: { staleTime: 5 * 60_000, gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

const RQ_CACHE_KEY = 'sendmast-rq-cache';

// Persist the query cache to localStorage so a refresh / re-open paints the last
// known data instantly (then revalidates in the background) instead of showing a
// spinner for a full ~1-3s round trip on the high-latency link to the US origin.
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: RQ_CACHE_KEY,
  // Skip queries that errored — only persist real data.
  throttleTime: 1000,
});

/** First chars of the current access token — used to bust the persisted cache
 *  so one account never restores another account's data on a shared browser. */
function authBuster(): string {
  try {
    const raw = localStorage.getItem('sendmast-auth');
    const token = raw ? JSON.parse(raw)?.state?.token : null;
    return token ? String(token).slice(0, 12) : 'anon';
  } catch {
    return 'anon';
  }
}

// On logout (token cleared), drop both the in-memory and persisted cache so the
// next user starts clean.
useAuth.subscribe((state, prev) => {
  if (prev.token && !state.token) {
    queryClient.clear();
    try {
      localStorage.removeItem(RQ_CACHE_KEY);
    } catch {
      /* ignore */
    }
  }
});

// NOTE: <React.StrictMode> is intentionally disabled — Easy Email 4.x relies on
// OverlayScrollbars 1.x and CodeMirror 5, both of which break under StrictMode's
// double-invoke effects (left blocks panel renders empty, Arco Collapse panels
// won't expand, source code editor won't mount). Re-enable once we move off Easy
// Email or it ships React 18 support.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        // Discard cache older than a day, and whenever the cache schema or the
        // signed-in account changes (buster mismatch → cache thrown away on restore).
        maxAge: 24 * 60 * 60 * 1000,
        buster: `v1-${authBuster()}`,
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PersistQueryClientProvider>
  </ErrorBoundary>,
);
