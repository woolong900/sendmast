import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { api, apiErrMessage } from '@/lib/api';
import type { ActivateResponse } from '@sendmast/shared';

/**
 * Public page reachable from the activation email's link
 * (`/activate?token=…`). Issues a single POST to redeem the token, shows a
 * success / failure state, and auto-bounces success cases to /dashboard
 * (logged-in users) or /login (logged-out users) after a brief pause.
 */
export function ActivatePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'pending' | 'ok' | 'invalid' | 'error'>('pending');
  const [email, setEmail] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // StrictMode mounts components twice in dev — without this guard we'd
  // fire two POSTs and the second one (using the now-used token) renders
  // an "invalid link" flash.
  const fired = useRef(false);

  useEffect(() => {
    if (!token) {
      setState('invalid');
      return;
    }
    if (fired.current) return;
    fired.current = true;
    (async () => {
      try {
        const r = await api.post<ActivateResponse>('/api/auth/activate', { token });
        if (r.data.ok) {
          setEmail(r.data.email ?? null);
          setState('ok');
          // Refresh /me cache so the banner disappears immediately if the
          // user is already logged in. We can't call the auth store from
          // here without circular imports, so the simplest path is a hard
          // navigate — the next page mount re-fetches /me.
          setTimeout(() => navigate('/dashboard', { replace: true }), 2000);
        } else {
          setState('invalid');
        }
      } catch (err) {
        setErrMsg(apiErrMessage(err));
        setState('error');
      }
    })();
  }, [token, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[hsl(220,17%,97%)] p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm sm:p-10">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BrandLogo className="size-4" />
          </div>
          <span className="text-lg font-semibold">SendMast</span>
        </div>

        {state === 'pending' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在激活账号…
          </div>
        )}

        {state === 'ok' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
              <div>
                <h1 className="text-base font-semibold">激活成功</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {email ? (
                    <>
                      账号 <span className="font-medium text-foreground">{email}</span> 已激活,
                      现在可以创建并发送邮件活动了。正在为您跳转…
                    </>
                  ) : (
                    <>账号已激活,现在可以创建并发送邮件活动了。正在为您跳转…</>
                  )}
                </p>
              </div>
            </div>
          </div>
        )}

        {state === 'invalid' && (
          <Failure
            title="链接无效"
            reason={
              token
                ? '激活链接无效或已过期。请回到平台,在顶部提示中点击"重新发送激活邮件"。'
                : '链接缺少 token 参数,无法激活。'
            }
          />
        )}

        {state === 'error' && (
          <Failure title="激活失败" reason={errMsg ?? '请稍后重试。'} />
        )}
      </div>
    </div>
  );
}

function Failure({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div>
          <h1 className="text-base font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
        </div>
      </div>
      <div className="flex gap-3 pt-2">
        <Link to="/dashboard" className="text-sm text-primary hover:underline">
          回到工作台
        </Link>
        <Link to="/login" className="text-sm text-muted-foreground hover:underline">
          返回登录
        </Link>
      </div>
    </div>
  );
}
