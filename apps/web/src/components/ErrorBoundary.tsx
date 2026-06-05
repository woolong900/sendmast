import { Component, type ReactNode } from 'react';
import { isDynamicImportError, reloadForStaleChunkOnce } from '@/lib/chunk-reload';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  /** True while we're hard-reloading to recover from a stale-deploy chunk miss. */
  reloading: boolean;
}

/**
 * Top-level safety net. Any render-phase exception that escapes a page or
 * provider bubbles here, so the user sees a recoverable error card instead
 * of a white screen. The CTA reloads the SPA (cheapest reliable "reset").
 *
 * Suspense/data errors thrown inside react-query's `useQuery` are NOT caught
 * here unless `throwOnError` is enabled on the query — those are typically
 * surfaced through inline `isError` states, which is fine.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): State {
    // Show a neutral "updating" screen (not the error card) while we reload to
    // recover from a stale-deploy chunk miss — the actual reload is kicked off
    // in componentDidCatch.
    return { error, reloading: isDynamicImportError(error) };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    if (isDynamicImportError(error)) {
      // Stale tab after a deploy: fetch a chunk that no longer exists. Reload
      // once. If we reloaded too recently (real failure), fall back to the card.
      if (!reloadForStaleChunkOnce()) {
        this.setState({ reloading: false });
      }
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.reloading) {
      return (
        <div className="flex h-screen w-full items-center justify-center bg-background p-6 text-sm text-muted-foreground">
          检测到新版本,正在刷新…
        </div>
      );
    }
    if (this.state.error) {
      return (
        <div className="flex h-screen w-full items-center justify-center bg-background p-6">
          <div className="max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
            <div className="text-lg font-semibold text-neutral-900">页面出错了</div>
            <div className="mt-2 text-sm text-neutral-600">
              抱歉,刚才发生了一个未预期的错误。请点击下方按钮刷新页面;如果问题持续,请联系管理员。
            </div>
            {import.meta.env.DEV && (
              <pre className="mt-4 max-h-48 overflow-auto rounded-md bg-neutral-50 p-3 text-xs text-rose-700">
                {this.state.error.message}
                {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
              </pre>
            )}
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-6 inline-flex h-9 items-center justify-center rounded-md bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-800"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
