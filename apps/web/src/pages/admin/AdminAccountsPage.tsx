import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
  const [editingAccount, setEditingAccount] = useState<AdminAccountView | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const { data: accounts, isLoading } = useQuery<AdminAccountView[]>({
    queryKey: ['admin', 'accounts'],
    queryFn: async () => (await api.get('/api/admin/accounts')).data,
  });
  const { data: acsAccounts } = useQuery<AcsAccountView[]>({
    queryKey: ['admin', 'acs-accounts'],
    queryFn: async () => (await api.get('/api/admin/acs-accounts')).data,
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

  async function handleSaveEdit(
    acsAccountIds: string[],
    primaryAcsAccountId: string | null,
    remaining: number,
    isCollaborator: boolean,
  ) {
    if (!editingAccount) return;
    setSavingEdit(true);
    try {
      await api.put(`/api/admin/accounts/${editingAccount.id}/acs-accounts`, {
        acsAccountIds,
        primaryAcsAccountId,
      });
      await api.patch(`/api/admin/accounts/${editingAccount.id}/quota`, { remaining });
      if (isCollaborator !== editingAccount.isCollaborator) {
        await api.patch(`/api/admin/accounts/${editingAccount.id}/collaborator`, {
          isCollaborator,
        });
      }
      toast('已更新', 'success');
      setEditingAccount(null);
      qc.invalidateQueries({ queryKey: ['admin', 'accounts'] });
    } catch (e) {
      toast(apiErrMessage(e), 'error');
    } finally {
      setSavingEdit(false);
    }
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
                <th className="px-4 py-3 font-medium">角色</th>
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
                    {a.isCollaborator ? (
                      <Badge variant="default" className="bg-violet-100 text-violet-700">
                        合作者
                      </Badge>
                    ) : (
                      <Badge variant="muted">普通租户</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={a.senderDomainCount > 0 ? 'default' : 'muted'}>
                      {a.senderDomainCount}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
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
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(a.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingAccount(a)}
                        title="修改该租户的 ACS 账号与剩余发送额度"
                      >
                        修改
                      </Button>
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

      {editingAccount && (
        <AccountEditModal
          account={editingAccount}
          acsAccounts={acsAccounts ?? []}
          pending={savingEdit}
          onClose={() => setEditingAccount(null)}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
}

/** ACS 账号列:只展示首个(优先主账号),绑定多个时追加省略号,悬浮显示全部。 */
function AccountEditModal({
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
  onSave: (
    acsAccountIds: string[],
    primaryAcsAccountId: string | null,
    remaining: number,
    isCollaborator: boolean,
  ) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(account.acsAccounts.map((a) => a.id)),
  );
  const [primary, setPrimary] = useState<string | null>(
    () => account.acsAccounts.find((a) => a.isPrimary)?.id ?? null,
  );
  const [quota, setQuota] = useState<string>(() => String(account.sendQuotaRemaining));
  const [collaborator, setCollaborator] = useState<boolean>(() => account.isCollaborator);

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
  const acsValid =
    ids.length === 0 ? primary === null : primary !== null && selected.has(primary);
  const quotaNum = Number(quota);
  const quotaValid = Number.isInteger(quotaNum) && quotaNum >= 0;
  const valid = acsValid && quotaValid;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 p-5">
          <div>
            <h2 className="text-lg font-semibold">修改租户 · {account.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              勾选该租户可发送的 ACS 账号(并指定一个为「主」,即添加域名时的默认 ACS),并设置剩余发送额度。
            </p>
          </div>

          <div>
            <div className="mb-1.5 text-sm font-medium">ACS 账号</div>
            <div className="max-h-[280px] space-y-1.5 overflow-y-auto">
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
          </div>

          <div>
            <div className="mb-1.5 text-sm font-medium">剩余发送额度</div>
            <input
              type="number"
              min={0}
              step={1000}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              disabled={pending}
            />
            {!quotaValid && (
              <p className="mt-1 text-xs text-destructive">请输入非负整数</p>
            )}
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                角色
                {collaborator ? (
                  <Badge variant="default" className="bg-violet-100 text-violet-700">
                    合作者
                  </Badge>
                ) : (
                  <Badge variant="muted">普通租户</Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                「合作者」活动数据显示真实投递情况(含真实弹回率);「普通租户」则软弹回并入送达、隐藏弹回率。
              </p>
            </div>
            <Switch
              checked={collaborator}
              disabled={pending}
              title="切换 合作者 / 普通租户"
              onCheckedChange={setCollaborator}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              取消
            </Button>
            <Button
              onClick={() => onSave(ids, primary, quotaNum, collaborator)}
              disabled={pending || !valid}
            >
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
