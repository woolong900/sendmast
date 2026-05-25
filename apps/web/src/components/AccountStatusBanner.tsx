import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/store/auth';
import { api, apiErrMessage } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

/**
 * 视口最顶部的全宽提示条(在侧栏与顶栏之上)。待激活时为绿色条+白字,与常见
 * 「系统公告」样式一致;封禁时为深红色条。待激活条背景色 #35c08e。
 */
export function AccountStatusBanner() {
  const { account, user } = useAuth();
  const status = account?.status;
  if (!status || status === 'active') return null;
  if (status === 'suspended') {
    return <SuspendedBanner reason={account?.suspendedReason ?? null} />;
  }
  return <PendingActivationBanner email={user?.email ?? null} />;
}

function SuspendedBanner({ reason }: { reason: string | null }) {
  return (
    <div className="flex w-full shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1.5 bg-rose-700 px-4 py-2.5 text-sm text-white">
      <span className="font-medium">账号已被封禁</span>
      <span className="text-center text-white/95">
        所有写操作已被冻结。
        {reason ? <>原因:{reason}。</> : null}
        如需恢复,请联系平台管理员。
      </span>
    </div>
  );
}

function PendingActivationBanner({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  // Soft cooldown so users don't spam the button before the server rate
  // limit kicks in. The server enforces 60s anyway; this is just UX.
  const cooldownMs = 60_000;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!sentAt) return;
    const t = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [sentAt]);
  // Suppress the unused-var warning while keeping the re-render dependency.
  void tick;
  const remaining = sentAt ? Math.max(0, sentAt + cooldownMs - Date.now()) : 0;
  const cooling = remaining > 0;

  async function handleResend() {
    setBusy(true);
    try {
      await api.post('/api/auth/resend-activation');
      setSentAt(Date.now());
      toast('激活邮件已重新发送,请查收。', 'success');
      // /me unchanged but kick a refetch in case the user just clicked the
      // activation link in another tab and we need to drop the banner.
      void qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast(apiErrMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2 bg-[#35c08e] px-4 py-2.5 text-sm text-white sm:px-8">
      <p className="max-w-3xl text-center leading-relaxed sm:text-left">
        账号待激活 · 已向 <span className="font-medium">{email ?? '注册邮箱'}</span>{' '}
        发送激活邮件,请点邮件内链接验证。未激活前不可创建/发送活动。
      </p>
      <button
        type="button"
        onClick={handleResend}
        disabled={busy || cooling}
        className="inline-flex shrink-0 items-center gap-1.5 rounded border border-white/90 bg-transparent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {cooling ? `请稍候 (${Math.ceil(remaining / 1000)}s)` : '重新发送激活邮件'}
      </button>
    </div>
  );
}
