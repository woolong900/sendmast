import { Suspense, useEffect } from 'react';
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
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar />
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
                <div className="mx-auto w-[1200px] py-4">
                  <Outlet />
                </div>
              )}
            </Suspense>
          </main>
        </div>
      </div>
    </div>
  );
}
