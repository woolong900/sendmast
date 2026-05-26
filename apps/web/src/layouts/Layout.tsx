import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { api } from '@/lib/api';
import { useAuth } from '@/store/auth';
import { AccountStatusBanner } from '@/components/AccountStatusBanner';

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, setProfile, logout } = useAuth();
  // The template editor needs the full viewport width — opt out of the centered container.
  const fullWidth =
    location.pathname === '/templates/new' ||
    /^\/templates\/[^/]+\/edit$/.test(location.pathname);

  // Mobile sidebar drawer state. Below the `md` breakpoint (768px) the
  // permanent sidebar is hidden; the hamburger in TopBar opens this slide-in
  // panel. Auto-closes on every route change so the user doesn't have to
  // dismiss it manually after navigating.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);
  // ESC closes the drawer. Bound only while open to avoid a permanent
  // global key listener.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && setMobileNavOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

  const { data, isError } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const r = await api.get('/api/auth/me');
      return r.data;
    },
    enabled: !!token,
  });

  useEffect(() => {
    if (data) setProfile({ user: data.user, account: data.account });
  }, [data, setProfile]);

  useEffect(() => {
    if (isError) {
      logout();
      navigate('/login', { replace: true });
    }
  }, [isError, logout, navigate]);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
      {/* 全宽置顶,在侧栏与顶栏之上 — 与参考图一致 */}
      <AccountStatusBanner />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Desktop sidebar — always visible at md+ */}
        <aside className="hidden h-full w-56 shrink-0 bg-sidebar text-sidebar-foreground md:flex">
          <Sidebar />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar onOpenMobileNav={() => setMobileNavOpen(true)} />
          <main className="flex-1 overflow-auto bg-[hsl(220,17%,97%)]">
            {/* Inner Suspense keeps sidebar/topbar/banner mounted while a lazy
                page chunk loads — without this the App-level Suspense fallback
                replaces the entire viewport on every nav, producing a flash. */}
            <Suspense fallback={null}>
              {fullWidth ? (
                <div className="h-full w-full">
                  <Outlet />
                </div>
              ) : (
                <div className="mx-auto w-full max-w-screen-xl px-4 py-4 sm:px-6 lg:px-8">
                  <Outlet />
                </div>
              )}
            </Suspense>
          </main>
        </div>
      </div>

      {/* Mobile drawer — only mounts while open so it doesn't steal touch
          events at md+ (also gated by md:hidden so any accidental open at
          desktop width is invisible). Hand-rolled instead of pulling in a
          dialog library; ~20 lines, no new deps. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="主导航"
            className="absolute inset-y-0 left-0 flex w-64 max-w-[80vw] bg-sidebar text-sidebar-foreground shadow-xl"
          >
            <Sidebar onNavigate={() => setMobileNavOpen(false)} />
          </aside>
        </div>
      )}
    </div>
  );
}
