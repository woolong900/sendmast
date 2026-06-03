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
  const [managing, setManaging] = useState<AdminAccountView | null>(null);
  const { data: accounts, isLoading } = useQuery<AdminAccountView[]>({
    queryKey: ['admin', 'accounts'],
    queryFn: async () => (await api.get('/api/admin/accounts')).data,
  });
  const { data: acsAccounts } = useQuery<AcsAccountView[]>({
    queryKey: ['admin', 'acs-accounts'],
    queryFn: async () => (await api.get('/api/admin/acs-accounts')).data,
  });

  const assignMut = useMutation({
    mutationFn: (input: {
      id: string;
      acsAccountIds: string[];
      primaryAcsAccountId: string | null;
    }) =>
      api.put(`/api/admin/accounts/${input.id}/acs-accounts`, {
        acsAccountIds: input.acsAccountIds,
        primaryAcsAccountId: input.primaryAcsAccountId,
      }),
    onSuccess: () => {
      toast('ACS 账号分配已更新', 'success');
      setManaging(null);
      qc.invalidateQueries({ queryKey: ['admin', 'accounts'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
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
          管理租户状态、分配 ACS 账号(可多选,标记一个为主)、设置剩余发送额度。封禁后该租户所有写操作会被拦截;额度 0 时活动会立即停止发送。
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">租户</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">ACS 账号</th>
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
                    <div className="flex max-w-[300px] flex-wrap items-center gap-1.5">
                      {a.acsAccounts.length === 0 ? (
                        <span className="text-xs text-muted-foreground">— 未分配 —</span>
                      ) : (
                        a.acsAccounts.map((acs) => (
                          <Badge key={acs.id} variant={acs.isPrimary ? 'default' : 'muted'}>
                            {acs.name}
                            {acs.isPrimary ? ' · 主' : ''}
                          </Badge>
                        ))
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setManaging(a)}>
                        管理
                      </Button>
                    </div>
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

      {managing && (
        <AcsAssignModal
          account={managing}
          acsAccounts={acsAccounts ?? []}
          pending={assignMut.isPending}
          onClose={() => setManaging(null)}
          onSave={(acsAccountIds, primaryAcsAccountId) =>
            assignMut.mutate({ id: managing.id, acsAccountIds, primaryAcsAccountId })
          }
        />
      )}
    </div>
  );
}

function AcsAssignModal({
  account,
  acsAccounts,
  pending,
  onClose,
  onSave,
}: {
  account: AdminAccountView;
  acsAccounts: AcsAccountView[];
  pending: boolean;
  onClose: () => void;
  onSave: (acsAccountIds: string[], primaryAcsAccountId: string | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(account.acsAccounts.map((a) => a.id)),
  );
  const [primary, setPrimary] = useState<string | null>(
    () => account.acsAccounts.find((a) => a.isPrimary)?.id ?? null,
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (primary === id) setPrimary(null);
      } else {
        next.add(id);
        if (primary === null) setPrimary(id);
      }
      return next;
    });
  }

  const ids = [...selected];
  const valid = ids.length === 0 ? primary === null : primary !== null && selected.has(primary);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 p-5">
          <div>
            <h2 className="text-lg font-semibold">分配 ACS 账号 · {account.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              勾选该租户可发送的 ACS 账号,并指定一个为「主」(添加域名时的默认 ACS)。
            </p>
          </div>
          <div className="max-h-[320px] space-y-1.5 overflow-y-auto">
            {acsAccounts.length === 0 && (
              <div className="text-sm text-muted-foreground">尚无 ACS 账号</div>
            )}
            {acsAccounts.map((acs) => {
              const checked = selected.has(acs.id);
              const inactive = acs.status !== 'active';
              return (
                <div
                  key={acs.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={pending || (inactive && !checked)}
                      onChange={() => toggle(acs.id)}
                    />
                    <span>{acs.name}</span>
                    {inactive && (
                      <span className="text-xs text-muted-foreground">({acs.status})</span>
                    )}
                  </label>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="radio"
                      name="primary-acs"
                      checked={primary === acs.id}
                      disabled={pending || !checked}
                      onChange={() => setPrimary(acs.id)}
                    />
                    主
                  </label>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              取消
            </Button>
            <Button onClick={() => onSave(ids, primary)} disabled={pending || !valid}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
