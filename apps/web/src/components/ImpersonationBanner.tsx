import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, UserCheck } from 'lucide-react';
import { api, apiErrMessage } from '@/lib/api';
import { useAuth } from '@/store/auth';
import { useToast } from '@/components/ui/toast';
import type { AuthTokens } from '@sendmast/shared';

/**
 * Yellow strip pinned to the very top of the viewport while a Platform Admin
 * is acting "as" another tenant. Shows who the admin originally was, which
 * workspace they're operating inside, and a one-click button to swap back
 * to their home account.
 */
export function ImpersonationBanner() {
  const { impersonation, account, refreshToken, setSession } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!impersonation || !account) return null;

  async function handleExit() {
    setBusy(true);
    try {
      const r = await api.post<AuthTokens>('/api/auth/end-impersonation');
      // Drop the just-revoked refresh token server-side too (best-effort —
      // the new pair already invalidates the access token, and the old
      // refresh row is still in the DB until /api/auth/refresh rotates it,
      // but we want to be explicit so concurrent tabs don't accidentally
      // re-use it).
      if (refreshToken) {
        api.post('/api/auth/logout', { refreshToken }).catch(() => undefined);
      }
      setSession({
        token: r.data.accessToken,
        refreshToken: r.data.refreshToken,
        // Clear user/account so /me on the next tick repopulates them with
        // the admin's home tenant rather than the impersonated one.
        user: null,
        account: null,
      });
      // /me query is keyed by ['me']; invalidating triggers an immediate
      // refetch which will repopulate the store (no impersonation flag this
      // time, so the banner unmounts on the next render).
      await qc.invalidateQueries();
      toast('已退出代登录', 'success');
      navigate('/admin/accounts', { replace: true });
    } catch (e) {
      toast(apiErrMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2 bg-amber-500 px-4 py-2.5 text-sm text-white sm:px-8">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <UserCheck className="size-4" />
        代登录中
      </span>
      <span className="text-center">
        正在以管理员身份操作工作区 <b>{account.name}</b>
        <span className="opacity-90"> ({account.slug})</span> · 原账号{' '}
        <b>{impersonation.originalUser.email}</b>
      </span>
      <button
        type="button"
        onClick={handleExit}
        disabled={busy}
        className="inline-flex shrink-0 items-center gap-1.5 rounded border border-white/90 bg-transparent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        退出代登录
      </button>
    </div>
  );
}
