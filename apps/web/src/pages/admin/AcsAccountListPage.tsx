import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Star, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import type {
  AcsAccountStatusValue,
  AcsAccountView,
  CreateAcsAccountInput,
} from '@sendmast/shared';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';

type FormState = CreateAcsAccountInput & { id?: string };

const EMPTY: FormState = {
  name: '',
  rpsLimit: 50,
  rpmLimit: 5000,
  rphLimit: 20000,
  rpdLimit: 500000,
  status: 'active',
  azureTenantId: '',
  azureClientId: '',
  azureClientSecret: '',
  azureSubscriptionId: '',
  azureResourceGroup: '',
  azureEmailServiceName: '',
  azureCommunicationServiceName: '',
};

export function AcsAccountListPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<FormState | null>(null);

  const { data, isLoading } = useQuery<AcsAccountView[]>({
    queryKey: ['admin', 'acs-accounts'],
    queryFn: async () => (await api.get('/api/admin/acs-accounts')).data,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/admin/acs-accounts/${id}`),
    onError: (err) => toast(`删除失败:${apiErrMessage(err)}`, 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'acs-accounts'] }),
  });

  const toggleStatusMut = useMutation({
    mutationFn: (input: { id: string; status: AcsAccountStatusValue }) =>
      api.patch(`/api/admin/acs-accounts/${input.id}`, { status: input.status }),
    onError: (err) => toast(`状态更新失败:${apiErrMessage(err)}`, 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'acs-accounts'] }),
  });

  const setDefaultMut = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/acs-accounts/${id}/default`),
    onError: (err) => toast(`设置默认失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: () => toast('已设为默认', 'success'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'acs-accounts'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">ACS 账号</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理 Azure Communication Services 账号:发送配额 + ARM 凭证(用于自动管理域名资源)。可将其中一个标记为默认,新注册的租户会自动绑定到默认账号。
          </p>
        </div>
        <Button onClick={() => setEditing({ ...EMPTY })}>
          <Plus className="mr-1 size-4" />
          新建账号
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">配额：秒/分/时/日</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">绑定域名</th>
                <th className="px-4 py-3 font-medium">创建时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={6} />}
              {!isLoading && data && data.length === 0 && <EmptyStateRow colSpan={6} />}
              {data?.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      <span>{a.name}</span>
                      {a.isDefault && (
                        <Badge variant="default" className="gap-1">
                          <Star className="size-3 fill-current" />
                          默认
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <QuotaPill label="秒" value={a.rpsLimit} className="bg-sky-50 text-sky-700" />
                      <QuotaPill label="分" value={a.rpmLimit} className="bg-emerald-50 text-emerald-700" />
                      <QuotaPill label="时" value={a.rphLimit} className="bg-amber-50 text-amber-700" />
                      <QuotaPill label="日" value={a.rpdLimit} className="bg-violet-50 text-violet-700" />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={a.status === 'active'}
                        disabled={toggleStatusMut.isPending}
                        title="启用 / 禁用"
                        onCheckedChange={(next) =>
                          toggleStatusMut.mutate({
                            id: a.id,
                            status: next ? 'active' : 'suspended',
                          })
                        }
                      />
                      <span className="text-xs text-muted-foreground">
                        {a.status === 'active' ? '启用' : a.status === 'retired' ? '退役' : '禁用'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex min-w-[2rem] justify-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
                        a.senderDomainCount > 0
                          ? 'bg-blue-50 text-blue-700'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {a.senderDomainCount}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(a.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {!a.isDefault && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={setDefaultMut.isPending || a.status !== 'active'}
                          title={
                            a.status !== 'active'
                              ? '仅 active 账号可设为默认'
                              : '设为新租户的默认 ACS 账号'
                          }
                          onClick={async () => {
                            const ok = await confirm({
                              title: '设为默认 ACS 账号',
                              description: (
                                <>
                                  设置后,新注册的租户会自动绑定 <span className="font-medium">{a.name}</span>。原默认账号(如有)将自动取消默认。
                                </>
                              ),
                              confirmLabel: '设为默认',
                            });
                            if (ok) setDefaultMut.mutate(a.id);
                          }}
                        >
                          <Star className="mr-1 size-3" />
                          设为默认
                        </Button>
                      )}
                      <button
                        type="button"
                        title="编辑"
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                        onClick={async () => {
                          const full = (
                            await api.get<AcsAccountView>(`/api/admin/acs-accounts/${a.id}`)
                          ).data;
                          setEditing({
                            id: full.id,
                            name: full.name,
                            rpsLimit: full.rpsLimit,
                            rpmLimit: full.rpmLimit,
                            rphLimit: full.rphLimit,
                            rpdLimit: full.rpdLimit,
                            status: full.status,
                            azureTenantId: full.azureTenantId,
                            azureClientId: full.azureClientId,
                            azureClientSecret: full.azureClientSecret,
                            azureSubscriptionId: full.azureSubscriptionId,
                            azureResourceGroup: full.azureResourceGroup,
                            azureEmailServiceName: full.azureEmailServiceName,
                            azureCommunicationServiceName: full.azureCommunicationServiceName ?? '',
                          });
                        }}
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        title="删除"
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                        disabled={deleteMut.isPending}
                        onClick={async () => {
                          const ok = await confirm({
                            title: '删除 ACS 账号',
                            description: (
                              <>
                                确定删除 <span className="font-medium">{a.name}</span> 吗?该账号当前绑定 {a.senderDomainCount} 个域名,删除后这些域名将无法继续发送邮件。
                              </>
                            ),
                            confirmLabel: '删除',
                            variant: 'danger',
                          });
                          if (ok) deleteMut.mutate(a.id);
                        }}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {editing && (
        <AccountEditor
          state={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['admin', 'acs-accounts'] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function QuotaPill({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums',
        className,
      )}
      title={`每${label}配额`}
    >
      <span className="opacity-60">{label}</span>
      {value.toLocaleString()}
    </span>
  );
}

function AccountEditor({
  state,
  onClose,
  onSaved,
}: {
  state: FormState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(state);
  useEffect(() => setForm(state), [state]);

  const isEdit = !!state.id;

  const saveMut = useMutation({
    mutationFn: () => {
      const body: CreateAcsAccountInput = {
        name: form.name,
        rpsLimit: Number(form.rpsLimit),
        rpmLimit: Number(form.rpmLimit),
        rphLimit: Number(form.rphLimit),
        rpdLimit: Number(form.rpdLimit),
        status: form.status,
        azureTenantId: form.azureTenantId.trim(),
        azureClientId: form.azureClientId.trim(),
        azureClientSecret: form.azureClientSecret,
        azureSubscriptionId: form.azureSubscriptionId.trim(),
        azureResourceGroup: form.azureResourceGroup.trim(),
        azureEmailServiceName: form.azureEmailServiceName.trim(),
        azureCommunicationServiceName: form.azureCommunicationServiceName?.trim() || null,
      };
      return isEdit
        ? api.patch(`/api/admin/acs-accounts/${state.id}`, body)
        : api.post('/api/admin/acs-accounts', body);
    },
    onSuccess: onSaved,
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">{isEdit ? '编辑 ACS 账号' : '新建 ACS 账号'}</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-5 p-5">
          <Section title="基本">
            <div>
              <Label className="mb-1.5 block">名称</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="acs-prod-eastus"
              />
            </div>
            <div>
              <Label className="mb-1.5 block">状态</Label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.status ?? 'active'}
                onChange={(e) =>
                  setForm({ ...form, status: e.target.value as AcsAccountStatusValue })
                }
              >
                <option value="active">启用</option>
                <option value="suspended">暂停</option>
                <option value="retired">退役</option>
              </select>
            </div>
          </Section>

          <Section title="速率配额">
            <div>
              <Label className="mb-1.5 block">每秒</Label>
              <Input
                type="number"
                value={form.rpsLimit}
                onChange={(e) => setForm({ ...form, rpsLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="mb-1.5 block">每分</Label>
              <Input
                type="number"
                value={form.rpmLimit}
                onChange={(e) => setForm({ ...form, rpmLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="mb-1.5 block">每时</Label>
              <Input
                type="number"
                value={form.rphLimit}
                onChange={(e) => setForm({ ...form, rphLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label className="mb-1.5 block">每日</Label>
              <Input
                type="number"
                value={form.rpdLimit}
                onChange={(e) => setForm({ ...form, rpdLimit: Number(e.target.value) })}
              />
            </div>
          </Section>

          <Section title="Azure ARM 凭证(用于域名管理)">
            <div>
              <Label className="mb-1.5 block">Tenant ID</Label>
              <Input
                value={form.azureTenantId}
                onChange={(e) => setForm({ ...form, azureTenantId: e.target.value })}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </div>
            <div>
              <Label className="mb-1.5 block">Subscription ID</Label>
              <Input
                value={form.azureSubscriptionId}
                onChange={(e) => setForm({ ...form, azureSubscriptionId: e.target.value })}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </div>
            <div>
              <Label className="mb-1.5 block">Client ID (Service Principal)</Label>
              <Input
                value={form.azureClientId}
                onChange={(e) => setForm({ ...form, azureClientId: e.target.value })}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </div>
            <div>
              <Label className="mb-1.5 block">Client Secret</Label>
              <Input
                type="password"
                value={form.azureClientSecret}
                onChange={(e) => setForm({ ...form, azureClientSecret: e.target.value })}
                placeholder="编辑时若不修改请保留默认值"
              />
            </div>
            <div>
              <Label className="mb-1.5 block">Resource Group</Label>
              <Input
                value={form.azureResourceGroup}
                onChange={(e) => setForm({ ...form, azureResourceGroup: e.target.value })}
                placeholder="rg-sendmast-prod"
              />
            </div>
            <div>
              <Label className="mb-1.5 block">Email Service Name</Label>
              <Input
                value={form.azureEmailServiceName}
                onChange={(e) => setForm({ ...form, azureEmailServiceName: e.target.value })}
                placeholder="ecs-sendmast-prod"
              />
            </div>
            <div className="md:col-span-2">
              <Label className="mb-1.5 block">Communication Service Name</Label>
              <Input
                value={form.azureCommunicationServiceName ?? ''}
                onChange={(e) =>
                  setForm({ ...form, azureCommunicationServiceName: e.target.value })
                }
                placeholder="acs-sendmast-prod"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Microsoft.Communication/communicationServices 资源名(跟 Email Service 同 RG,但是另一个资源)。域名验证通过后会自动 link 到这个 Communication Service,系统使用其 endpoint + Service Principal 凭证发送邮件。
              </p>
            </div>
          </Section>

          {saveMut.isError && (
            <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
              {apiErrMessage(saveMut.error)}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}
