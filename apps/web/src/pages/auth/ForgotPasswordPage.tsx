import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, apiErrMessage } from '@/lib/api';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // The backend deliberately returns 200 regardless of whether the email
      // exists, so we simply switch to the success view on any 2xx.
      await api.post('/api/auth/forgot-password', { email });
      setSubmitted(true);
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

        {submitted ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
              <div>
                <h1 className="text-base font-semibold">请查收邮件</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  如果 <span className="font-medium text-foreground">{email}</span>{' '}
                  对应的账号存在，我们已向其发送了重置密码的链接。链接 1 小时内有效。
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  没收到？请检查垃圾邮件文件夹，或稍后再试一次。
                </p>
              </div>
            </div>
            <div className="pt-2">
              <Link
                to="/login"
                className="text-sm text-primary hover:underline"
              >
                返回登录
              </Link>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-semibold">找回密码</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              输入您的注册邮箱，我们将向您发送重置密码的链接。
            </p>
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
                  autoFocus
                />
              </div>
              {error && (
                <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={busy || !email.trim()}>
                {busy ? '发送中...' : '发送重置链接'}
              </Button>
              <div className="text-center text-sm text-muted-foreground">
                想起来了？{' '}
                <Link to="/login" className="text-primary hover:underline">
                  返回登录
                </Link>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
