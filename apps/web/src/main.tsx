import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
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
