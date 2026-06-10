import { useState } from 'react';
import { Link, useLocation, useNavigate, type Location } from 'react-router-dom';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, apiErrMessage } from '@/lib/api';
import { useAuth } from '@/store/auth';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useAuth((s) => s.setSession);

  // Set by RequireAuth when it bounced an unauthenticated deep link here;
  // includes pathname + search so one-time query params (e.g. the Shopyy
  // authorize callback's `code`) survive the round-trip through login.
  const from = (location.state as { from?: Location } | null)?.from;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.post('/api/auth/login', { email, password });
      // Wipe any stale persisted auth state from a previous (possibly broken)
      // session before writing the new one — guards against zustand-persist
      // re-hydrating an old token/account over the fresh values during the
      // dashboard's first render.
      await useAuth.persist.clearStorage();
      setSession({
        token: r.data.accessToken,
        refreshToken: r.data.refreshToken,
      });
      navigate(from ?? '/dashboard', { replace: true });
    } catch (err) {
      setError(apiErrMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[hsl(220,17%,97%)] p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm sm:p-10">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BrandLogo className="size-4" />
          </div>
          <span className="text-lg font-semibold">SendMast</span>
        </div>
        <h1 className="text-xl font-semibold">登录</h1>
        <p className="mt-1 text-sm text-muted-foreground">使用您的账户登录 SendMast</p>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">密码</Label>
              <Link
                to="/forgot-password"
                className="text-xs text-primary hover:underline"
              >
                忘记密码？
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error && <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? '登录中...' : '登录'}
          </Button>
          <div className="text-center text-sm text-muted-foreground">
            没有账号？{' '}
            <Link to="/signup" className="text-primary hover:underline">
              立即注册
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
