import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, apiErrMessage } from '@/lib/api';
import type { ResetTokenValidateResponse } from '@sendmast/shared';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const validate = useQuery<ResetTokenValidateResponse>({
    queryKey: ['reset-token', token],
    queryFn: async () =>
      (await api.get('/api/auth/reset-password/validate', { params: { token } })).data,
    enabled: !!token,
    retry: false,
  });

  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw1.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (pw1 !== pw2) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', { token, newPassword: pw1 });
      setDone(true);
      // Auto-redirect back to login after a moment so the user sees the
      // success state and isn't yanked away too quickly.
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err) {
      setError(apiErrMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[hsl(220,17%,97%)] p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-10 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BrandLogo className="size-4" />
          </div>
          <span className="text-lg font-semibold">SendMast</span>
        </div>

        {!token ? (
          <InvalidLink reason="链接缺少 token 参数" />
        ) : validate.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在校验链接…
          </div>
        ) : !validate.data?.ok ? (
          <InvalidLink reason="链接无效或已过期。请返回登录页重新申请。" />
        ) : done ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
              <div>
                <h1 className="text-base font-semibold">密码已重置</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  您的密码已成功更新，所有其他登录会话已自动登出。
                  正在为您跳转到登录页…
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-semibold">设置新密码</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              账号 <span className="font-medium text-foreground">{validate.data.email}</span>
            </p>
            <form className="mt-6 space-y-4" onSubmit={onSubmit}>
              <div className="space-y-1.5">
                <Label htmlFor="pw1">新密码</Label>
                <Input
                  id="pw1"
                  type="password"
                  required
                  value={pw1}
                  onChange={(e) => setPw1(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  placeholder="至少 8 位"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pw2">确认新密码</Label>
                <Input
                  id="pw2"
                  type="password"
                  required
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              {error && (
                <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? '提交中...' : '设置新密码'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function InvalidLink({ reason }: { reason: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div>
          <h1 className="text-base font-semibold">链接无效</h1>
          <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
        </div>
      </div>
      <div className="flex gap-3 pt-2">
        <Link
          to="/forgot-password"
          className="text-sm text-primary hover:underline"
        >
          重新申请重置链接
        </Link>
        <Link to="/login" className="text-sm text-muted-foreground hover:underline">
          返回登录
        </Link>
      </div>
    </div>
  );
}
