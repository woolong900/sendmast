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
import {
  ACCOUNT_ROLES,
  type AccountRole,
  type AssignedEmailChannelView,
  type EmailChannelView,
  type AdminAccountView,
  type AuthTokens,
  type SetAccountStatusInput,
} from '@sendmast/shared';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';

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

const ROLE_LABEL: Record<AccountRole, string> = {
  platform_admin: '平台管理员',
  collaborator: '合作者',
  tenant: '普通租户',
};
const ROLE_DESC: Record<AccountRole, string> = {
  platform_admin: '全局平台管理员(可管理整个平台);活动数据显示真实投递情况。',
  collaborator: '合作者:活动数据显示真实投递情况(含真实弹回率)。',
  tenant: '普通租户:软弹回并入送达、隐藏弹回率。',
};
function RoleBadge({ role }: { role: AccountRole }) {
  if (role === 'platform_admin') {
    return (
      <Badge variant="default" className="bg-rose-100 text-rose-700">
        平台管理员
      </Badge>
    );
  }
  if (role === 'collaborator') {
    return (
      <Badge variant="default" className="bg-violet-100 text-violet-700">
        合作者
      </Badge>
    );
  }
  return <Badge variant="muted">普通租户</Badge>;
}

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
  const { data: emailChannels } = useQuery<EmailChannelView[]>({
    queryKey: ['admin', 'email-channels'],
    queryFn: async () => (await api.get('/api/admin/email-channels')).data,
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
    emailChannels: Array<{
      id: string;
      allowMarketing: boolean;
      allowTransactional: boolean;
    }>,
    primaryEmailChannelId: string | null,
    remaining: number,
    role: AccountRole,
  ) {
    if (!editingAccount) return;
    setSavingEdit(true);
    try {
      await api.put(`/api/admin/accounts/${editingAccount.id}/email-channels`, {
        emailChannels,
        primaryEmailChannelId,
      });
      await api.patch(`/api/admin/accounts/${editingAccount.id}/quota`, { remaining });
      if (role !== editingAccount.role) {
        await api.patch(`/api/admin/accounts/${editingAccount.id}/role`, { role });
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
          管理租户状态、分配邮件通道(可多选,标记一个为主并设置营销/事务用途)、设置剩余发送额度。封禁后该租户所有写操作会被拦截;额度 0 时活动会立即停止发送。
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[1060px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">租户</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">角色</th>
                <th className="px-4 py-3 font-medium">邮件通道</th>
                <th className="px-4 py-3 font-medium">已添加域名</th>
                <th className="px-4 py-3 font-medium">剩余发送额度</th>
                <th className="px-4 py-3 font-medium">注册时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={8} />}
              {!isLoading && accounts && accounts.length === 0 && (
                <EmptyStateRow colSpan={8} />
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
                    <RoleBadge role={a.role} />
                  </td>
                  <td className="px-4 py-3">
                    <EmailChannelSummary channels={a.emailChannels} />
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
                        title="修改该租户的邮件通道与剩余发送额度"
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
          </div>
        </CardContent>
      </Card>

      {editingAccount && (
        <AccountEditModal
          account={editingAccount}
          emailChannels={emailChannels ?? []}
          pending={savingEdit}
          onClose={() => setEditingAccount(null)}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
}

/** 邮件通道列:只展示首个(优先主账号),绑定多个时追加省略号,悬浮显示全部。 */
function EmailChannelSummary({ channels }: { channels: AssignedEmailChannelView[] }) {
  if (channels.length === 0) return <span className="text-xs text-muted-foreground">未分配</span>;
  const sorted = [...channels].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const first = sorted[0];
  const title = sorted
    .map((c) => `${c.name}${c.isPrimary ? ' · 主' : ''} · ${usageLabel(c)}`)
    .join('\n');
  return (
    <div className="max-w-[220px]" title={title}>
      <div className="truncate text-sm font-medium">
        {first.name}
        {first.isPrimary ? ' · 主' : ''}
        {channels.length > 1 ? ` +${channels.length - 1}` : ''}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {first.allowMarketing && <Badge variant="muted">营销</Badge>}
        {first.allowTransactional && <Badge variant="muted">事务</Badge>}
      </div>
    </div>
  );
}

function usageLabel(channel: Pick<AssignedEmailChannelView, 'allowMarketing' | 'allowTransactional'>) {
  if (channel.allowMarketing && channel.allowTransactional) return '营销/事务';
  if (channel.allowMarketing) return '营销';
  if (channel.allowTransactional) return '事务';
  return '未启用';
}

function AccountEditModal({
  account,
  emailChannels,
  pending,
  onClose,
  onSave,
}: {
  account: AdminAccountView;
  emailChannels: EmailChannelView[];
  pending: boolean;
  onClose: () => void;
  onSave: (
    emailChannels: Array<{
      id: string;
      allowMarketing: boolean;
      allowTransactional: boolean;
    }>,
    primaryEmailChannelId: string | null,
    remaining: number,
    role: AccountRole,
  ) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(account.emailChannels.map((a) => a.id)),
  );
  const [primary, setPrimary] = useState<string | null>(
    () => account.emailChannels.find((a) => a.isPrimary)?.id ?? null,
  );
  const [quota, setQuota] = useState<string>(() => String(account.sendQuotaRemaining));
  const [role, setRole] = useState<AccountRole>(() => account.role);
  const [usage, setUsage] = useState<
    Record<string, { allowMarketing: boolean; allowTransactional: boolean }>
  >(() =>
    Object.fromEntries(
      account.emailChannels.map((a) => [
        a.id,
        {
          allowMarketing: a.allowMarketing,
          allowTransactional: a.allowTransactional,
        },
      ]),
    ),
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
        setUsage((u) => ({
          ...u,
          [id]: u[id] ?? { allowMarketing: true, allowTransactional: true },
        }));
      }
      return next;
    });
  }

  function toggleUsage(id: string, key: 'allowMarketing' | 'allowTransactional') {
    setUsage((prev) => {
      const current = prev[id] ?? { allowMarketing: true, allowTransactional: true };
      const next = { ...current, [key]: !current[key] };
      return { ...prev, [id]: next };
    });
  }

  const ids = [...selected];
  const channelValid =
    ids.length === 0
      ? primary === null
      : primary !== null &&
        selected.has(primary) &&
        ids.every((id) => {
          const u = usage[id] ?? { allowMarketing: true, allowTransactional: true };
          return u.allowMarketing || u.allowTransactional;
        });
  const quotaNum = Number(quota);
  const quotaValid = Number.isInteger(quotaNum) && quotaNum >= 0;
  const valid = channelValid && quotaValid;
  const assignments: Array<Pick<AssignedEmailChannelView, 'id' | 'allowMarketing' | 'allowTransactional'>> =
    ids.map((id) => ({
      id,
      allowMarketing: usage[id]?.allowMarketing ?? true,
      allowTransactional: usage[id]?.allowTransactional ?? true,
    }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="max-h-[90vh] w-full max-w-lg overflow-y-auto">
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div>
            <h2 className="text-lg font-semibold">修改租户 · {account.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              勾选该租户可发送的邮件通道(并指定一个为「主」,即添加域名时的默认通道),并设置剩余发送额度。
            </p>
          </div>

          <div>
            <div className="mb-1.5 text-sm font-medium">邮件通道</div>
            <div className="max-h-[280px] space-y-1.5 overflow-y-auto">
              {emailChannels.length === 0 && (
                <div className="text-sm text-muted-foreground">尚无邮件通道</div>
              )}
              {emailChannels.map((channel) => {
                const checked = selected.has(channel.id);
                const inactive = channel.status !== 'active';
                return (
                  <div
                    key={channel.id}
                    className="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <label className="flex min-w-0 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={pending || (inactive && !checked)}
                        onChange={() => toggle(channel.id)}
                      />
                      <span className="min-w-0 truncate">{channel.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {channel.provider === 'mailgun' ? 'Mailgun' : 'Azure'}
                      </span>
                      {inactive && (
                        <span className="text-xs text-muted-foreground">({channel.status})</span>
                      )}
                    </label>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={usage[channel.id]?.allowMarketing ?? checked}
                          disabled={pending || !checked}
                          onChange={() => toggleUsage(channel.id, 'allowMarketing')}
                        />
                        营销
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={usage[channel.id]?.allowTransactional ?? checked}
                          disabled={pending || !checked}
                          onChange={() => toggleUsage(channel.id, 'allowTransactional')}
                        />
                        事务
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="primary-channel"
                          checked={primary === channel.id}
                          disabled={pending || !checked}
                          onChange={() => setPrimary(channel.id)}
                        />
                        主
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            {!channelValid && ids.length > 0 && (
              <p className="mt-1 text-xs text-destructive">
                每个已分配通道至少需要勾选一个可用场景，并指定一个主通道。
              </p>
            )}
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

          <div>
            <div className="mb-1.5 text-sm font-medium">角色</div>
            <div className="space-y-1.5">
              {ACCOUNT_ROLES.map((r) => (
                <label
                  key={r}
                  className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-muted/40"
                >
                  <input
                    type="radio"
                    name="account-role"
                    className="mt-0.5"
                    checked={role === r}
                    disabled={pending}
                    onChange={() => setRole(r)}
                  />
                  <span className="min-w-0">
                    <span className="text-sm font-medium">{ROLE_LABEL[r]}</span>
                    <span className="block text-xs text-muted-foreground">{ROLE_DESC[r]}</span>
                  </span>
                </label>
              ))}
            </div>
            {role === 'platform_admin' && role !== account.role && (
              <p className="mt-1.5 text-xs text-amber-600">
                注意:将把该租户的所有者用户提升为全局平台管理员。
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              取消
            </Button>
            <Button
              onClick={() => onSave(assignments, primary, quotaNum, role)}
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
