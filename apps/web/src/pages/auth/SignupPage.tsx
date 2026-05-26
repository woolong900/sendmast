import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, apiErrMessage } from '@/lib/api';
import { useAuth } from '@/store/auth';

export function SignupPage() {
  const navigate = useNavigate();
  const setSession = useAuth((s) => s.setSession);

  const [accountName, setAccountName] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.post('/api/auth/signup', {
        accountName,
        email,
        displayName: displayName || undefined,
        password,
      });
      await useAuth.persist.clearStorage();
      setSession({
        token: r.data.accessToken,
        refreshToken: r.data.refreshToken,
      });
      navigate('/dashboard', { replace: true });
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
        <h1 className="text-xl font-semibold">创建账号</h1>
        <p className="mt-1 text-sm text-muted-foreground">免费注册，开始你的邮件营销之旅</p>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="accountName">工作区名称</Label>
            <Input
              id="accountName"
              required
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="例如：我的公司"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="displayName">姓名</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="选填"
            />
          </div>
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
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">至少 8 位</p>
          </div>
          {error && <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? '创建中...' : '创建账号'}
          </Button>
          <div className="text-center text-sm text-muted-foreground">
            已有账号？{' '}
            <Link to="/login" className="text-primary hover:underline">
              直接登录
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
