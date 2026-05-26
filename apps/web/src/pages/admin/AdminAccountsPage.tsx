import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, apiErrMessage } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/utils';
import { useAuth } from '@/store/auth';
import type {
  AcsAccountView,
  AdminAccountView,
  AuthTokens,
  SetAccountStatusInput,
} from '@sendmast/shared';
import { EmptyStateRow } from '@/components/ui/empty-state';

const STATUS_LABEL: Record<AdminAccountView['status'], string> = {
  pending_activation: '待激活',
  active: '已激活',
  suspended: '已封禁',
};
const STATUS_VARIANT: Record<
  AdminAccountView['status'],
  'success' | 'warning' | 'danger'
> = {
  pending_activation: 'warning',
  active: 'success',
  suspended: 'danger',
};

export function AdminAccountsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const setSession = useAuth((s) => s.setSession);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const { data: accounts, isLoading } = useQuery<AdminAccountView[]>({
    queryKey: ['admin', 'accounts'],
    queryFn: async () => (await api.get('/api/admin/accounts')).data,
  });
  const { data: acsAccounts } = useQuery<AcsAccountView[]>({
    queryKey: ['admin', 'acs-accounts'],
    queryFn: async () => (await api.get('/api/admin/acs-accounts')).data,
  });

  const assignMut = useMutation({
    mutationFn: (input: { id: string; acsAccountId: string | null }) =>
      api.patch(`/api/admin/accounts/${input.id}/default-acs-account`, {
        acsAccountId: input.acsAccountId,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'accounts'] }),
  });

  const quotaMut = useMutation({
    mutationFn: (input: { id: string; remaining: number }) =>
      api.patch(`/api/admin/accounts/${input.id}/quota`, { remaining: input.remaining }),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['admin', 'accounts'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const statusMut = useMutation({
    mutationFn: (input: { id: string } & SetAccountStatusInput) =>
      api.patch(`/api/admin/accounts/${input.id}/status`, {
        status: input.status,
        reason: input.reason,
      }),
    onSuccess: (_d, vars) => {
      const verb =
        vars.status === 'active'
          ? '已激活'
          : vars.status === 'suspended'
            ? '已封禁'
            : '已设为待激活';
      toast(`租户${verb}`, 'success');
      qc.invalidateQueries({ queryKey: ['admin', 'accounts'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  async function handleActivate(a: AdminAccountView) {
    const ok = await confirm({
      title: '激活该租户?',
      description: (
        <span>
          将把 <b>{a.name}</b> 状态改为「已激活」。该租户即刻可创建并发送邮件活动。
        </span>
      ),
      confirmLabel: '激活',
    });
    if (!ok) return;
    statusMut.mutate({ id: a.id, status: 'active' });
  }

  async function handleSuspend(a: AdminAccountView) {
    const reason = window.prompt(`封禁租户「${a.name}」的原因(可选,会展示在该租户顶部提示中):`, '');
    // Cancel button on prompt returns null; empty string = no reason.
    if (reason === null) return;
    const ok = await confirm({
      title: '确认封禁?',
      description: (
        <span>
          封禁后该租户的所有写操作(创建/修改/删除/发送)都会被拦截,只能查看现有数据。
        </span>
      ),
      confirmLabel: '封禁',
      variant: 'danger',
    });
    if (!ok) return;
    statusMut.mutate({
      id: a.id,
      status: 'suspended',
      reason: reason.trim() || undefined,
    });
  }

  async function handleUnsuspend(a: AdminAccountView) {
    const ok = await confirm({
      title: '解除封禁?',
      description: (
        <span>
          将把 <b>{a.name}</b> 状态改回「已激活」,所有功能恢复正常。
        </span>
      ),
      confirmLabel: '解除封禁',
    });
    if (!ok) return;
    statusMut.mutate({ id: a.id, status: 'active' });
  }

  async function handleImpersonate(a: AdminAccountView) {
    const ok = await confirm({
      title: `代登录 ${a.name}?`,
      description: (
        <span>
          将以管理员身份进入工作区 <b>{a.name}</b>,可对其营销活动、联系人、分群、模板、发件域名、订单、自定义标签等执行任意读写操作。顶栏会一直显示«代登录中»提示,可随时退出。
        </span>
      ),
      confirmLabel: '代登录',
    });
    if (!ok) return;
    setImpersonatingId(a.id);
    try {
      const r = await api.post<AuthTokens>(`/api/admin/accounts/${a.id}/impersonate`);
      setSession({
        token: r.data.accessToken,
        refreshToken: r.data.refreshToken,
        user: null,
        account: null,
      });
      await qc.invalidateQueries();
      toast(`已代登录:${a.name}`, 'success');
      navigate('/dashboard', { replace: true });
    } catch (e) {
      toast(apiErrMessage(e), 'error');
    } finally {
      setImpersonatingId(null);
    }
  }

  function commitQuota() {
    if (!editing) return;
    const n = Number(editing.value);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      toast('请输入非负整数', 'error');
      return;
    }
    quotaMut.mutate({ id: editing.id, remaining: n });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">租户管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理租户状态、指定默认 ACS 账号、设置剩余发送额度。封禁后该租户所有写操作会被拦截;额度 0 时活动会立即停止发送。
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">租户</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">默认 ACS 账号</th>
                <th className="px-4 py-3 font-medium">已添加域名</th>
                <th className="px-4 py-3 font-medium">剩余发送额度</th>
                <th className="px-4 py-3 font-medium">注册时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    加载中...
                  </td>
                </tr>
              )}
              {!isLoading && accounts && accounts.length === 0 && (
                <EmptyStateRow colSpan={7} />
              )}
              {accounts?.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {a.ownerEmail ?? a.slug}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_VARIANT[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                    {a.status === 'suspended' && a.suspendedReason ? (
                      <div
                        className="mt-1 max-w-[180px] truncate text-xs text-muted-foreground"
                        title={a.suspendedReason}
                      >
                        {a.suspendedReason}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      className="h-9 w-[280px] rounded-md border border-input bg-background px-3 text-sm"
                      value={a.defaultAcsAccount?.id ?? ''}
                      onChange={(e) =>
                        assignMut.mutate({
                          id: a.id,
                          acsAccountId: e.target.value || null,
                        })
                      }
                      disabled={assignMut.isPending}
                    >
                      <option value="">— 未分配 —</option>
                      {acsAccounts?.map((acs) => (
                        <option
                          key={acs.id}
                          value={acs.id}
                          disabled={acs.status !== 'active'}
                        >
                          {acs.name}
                          {acs.status !== 'active' ? ` (${acs.status})` : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={a.senderDomainCount > 0 ? 'default' : 'muted'}>
                      {a.senderDomainCount}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {editing?.id === a.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          step={1000}
                          autoFocus
                          className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm"
                          value={editing.value}
                          onChange={(e) => setEditing({ id: a.id, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitQuota();
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          disabled={quotaMut.isPending}
                        />
                        <Button
                          size="sm"
                          onClick={commitQuota}
                          disabled={quotaMut.isPending}
                        >
                          保存
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(null)}
                          disabled={quotaMut.isPending}
                        >
                          取消
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({ id: a.id, value: String(a.sendQuotaRemaining) })
                        }
                        className="group inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
                        title="点击修改"
                      >
                        <span
                          className={
                            a.sendQuotaRemaining === 0
                              ? 'font-medium text-destructive'
                              : a.sendQuotaRemaining < 1000
                                ? 'font-medium text-amber-600'
                                : 'font-medium'
                          }
                        >
                          {formatNumber(a.sendQuotaRemaining)}
                        </span>
                        <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100">
                          修改
                        </span>
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(a.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleImpersonate(a)}
                        disabled={impersonatingId === a.id}
                        title="以管理员身份进入该工作区,可读写其全部数据"
                      >
                        {impersonatingId === a.id ? '进入中…' : '代登录'}
                      </Button>
                      {a.status === 'pending_activation' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleActivate(a)}
                          disabled={statusMut.isPending}
                        >
                          手动激活
                        </Button>
                      )}
                      {a.status === 'suspended' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleUnsuspend(a)}
                          disabled={statusMut.isPending}
                        >
                          解除封禁
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSuspend(a)}
                          disabled={statusMut.isPending}
                          className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                        >
                          封禁
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {assignMut.isError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {apiErrMessage(assignMut.error)}
        </div>
      )}
    </div>
  );
}
