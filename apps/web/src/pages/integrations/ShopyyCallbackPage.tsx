import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { api, apiErrMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * Landing page for the shopyy authorize redirect. Shopyy sends the merchant
 * back here with `code` + `authorize_token_url`; we (already logged in, JWT in
 * memory) POST them to the API which signs the exchange and binds the store to
 * this tenant. RequireAuth wraps this route, so an unauthenticated hit bounces
 * to /login first.
 */
export function ShopyyCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [message, setMessage] = useState('正在完成店铺授权...');
  const ran = useRef(false);

  const code = params.get('code');
  const authorizeTokenUrl =
    params.get('authorize_token_url') ?? params.get('authorizeTokenUrl');

  useEffect(() => {
    // StrictMode double-invokes effects in dev; the code is single-use so guard.
    if (ran.current) return;
    ran.current = true;

    if (!code || !authorizeTokenUrl) {
      setState('error');
      setMessage('授权参数缺失（缺少 code 或 authorize_token_url）。');
      return;
    }
    api
      .post('/api/integrations/shopyy/connect', { code, authorizeTokenUrl })
      .then((res) => {
        const name = res.data?.shopName ?? res.data?.shopDomain ?? '店铺';
        setState('ok');
        setMessage(`已成功连接「${name}」。`);
        setTimeout(() => navigate('/settings/shop', { replace: true }), 1200);
      })
      .catch((err) => {
        setState('error');
        setMessage(apiErrMessage(err));
      });
  }, [code, authorizeTokenUrl, navigate]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
        {state === 'working' && (
          <Loader2 className="mx-auto mb-3 size-10 animate-spin text-primary" />
        )}
        {state === 'ok' && (
          <CheckCircle2 className="mx-auto mb-3 size-10 text-emerald-500" />
        )}
        {state === 'error' && <XCircle className="mx-auto mb-3 size-10 text-destructive" />}
        <h1 className="text-lg font-semibold">
          {state === 'working' ? '连接中' : state === 'ok' ? '连接成功' : '连接失败'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        {state === 'error' && (
          <Button className="mt-5" onClick={() => navigate('/settings/shop')}>
            返回店铺设置
          </Button>
        )}
      </div>
    </div>
  );
}
