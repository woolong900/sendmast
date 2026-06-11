import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
    // User-facing data should always be checked against the API when a page
    // mounts or the tab regains focus. Keep only active-query de-duplication;
    // discard inactive results immediately so stale state cannot linger.
    queries: { staleTime: 0, gcTime: 0, refetchOnWindowFocus: true, retry: 1 },
  },
});

// Remove data persisted by versions that used PersistQueryClientProvider.
try {
  localStorage.removeItem('sendmast-rq-cache');
} catch {
  /* ignore */
}

// On logout (token cleared), drop in-memory query state so the next user starts
// clean even if the login route mounts before inactive queries are collected.
useAuth.subscribe((state, prev) => {
  if (prev.token && !state.token) {
    queryClient.clear();
  }
});

// NOTE: <React.StrictMode> is intentionally disabled — Easy Email 4.x relies on
// OverlayScrollbars 1.x and CodeMirror 5, both of which break under StrictMode's
// double-invoke effects (left blocks panel renders empty, Arco Collapse panels
// won't expand, source code editor won't mount). Re-enable once we move off Easy
// Email or it ships React 18 support.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </ErrorBoundary>,
);
