import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, RefreshCw, Trash2, CheckCircle2, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import type { SenderDomainView, TenantAcsAccountView } from '@sendmast/shared';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';

type DomainView = SenderDomainView;

export function SenderDomainsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  // Track which row is currently being deleted so we can show a per-row
  // spinner instead of disabling every row's delete button (the upstream
  // Azure delete LRO takes ~10s and react-query's `isPending` is mutation-
  // wide, not per-call).
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { data, isLoading } = useQuery<DomainView[]>({
    queryKey: ['sender-domains'],
    queryFn: async () => (await api.get('/api/sender-domains')).data,
  });
  // Surface which ACS account each domain belongs to only when the tenant has
  // more than one assigned (single-ACS tenants don't need the extra column).
  const { data: acsAccounts } = useQuery<TenantAcsAccountView[]>({
    queryKey: ['sender-domains', 'acs-accounts'],
    queryFn: async () => (await api.get('/api/sender-domains/acs-accounts')).data,
  });
  const multiAcs = (acsAccounts?.length ?? 0) > 1;
  const colCount = multiAcs ? 6 : 5;

  const verifyMut = useMutation({
    mutationFn: (id: string) => api.post(`/api/sender-domains/${id}/verify`),
    onError: (err) => toast(`检测失败:${apiErrMessage(err)}`, 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sender-domains'] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/sender-domains/${id}`),
    onError: (err) => toast(`删除失败:${apiErrMessage(err)}`, 'error'),
    onSettled: (_data, _err, id) => {
      qc.invalidateQueries({ queryKey: ['sender-domains'] });
      // Only clear the marker if it still belongs to this call — guards
      // against races where two deletes are issued back-to-back.
      setDeletingId((cur) => (cur === id ? null : cur));
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">发件域名</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            添加并验证发件域名后才能使用 SendMast 发送邮件。
          </p>
        </div>
        <Button asChild className="w-full sm:w-auto">
          <Link to="/settings/domains/new">
            <Plus className="mr-1 size-4" />
            添加域名
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">域名</th>
                <th className="px-4 py-3 font-medium">状态</th>
                {multiAcs && <th className="px-4 py-3 font-medium">所属 ACS 账号</th>}
                <th className="px-4 py-3 font-medium">发件人</th>
                <th className="px-4 py-3 font-medium">最近检测</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={colCount} />}
              {!isLoading && data && data.length === 0 && <EmptyStateRow colSpan={colCount} />}
              {data?.map((d) => {
                // Domain is fully usable once DNS is verified AND there's at
                // least one sender username (link to CommunicationService is
                // performed automatically by the backend during verify, so
                // we don't need to expose it as a separate state).
                const ready = d.status === 'verified' && d.senderUsernames.length > 0;
                const needsConfig =
                  !ready && d.status !== 'provisioning' && d.status !== 'failed';
                const continueLabel = d.status === 'verified' ? '添加发件人' : '继续配置';
                const isDeleting = deletingId === d.id;
                const isDeletingOther = deletingId !== null && !isDeleting;
                return (
                  <tr
                    key={d.id}
                    className={
                      'border-b last:border-0 transition-opacity ' +
                      (isDeleting ? 'opacity-60' : '')
                    }
                  >
                    <td className="px-4 py-3 font-medium">
                      <Link to={`/settings/domains/new?id=${d.id}`} className="hover:underline">
                        {d.domain}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {isDeleting ? (
                        <Badge variant="muted">
                          <Loader2 className="mr-1 size-3 animate-spin" />
                          删除中
                        </Badge>
                      ) : d.status === 'verified' ? (
                        <Badge variant="success">
                          <CheckCircle2 className="mr-1 size-3" />
                          已验证
                        </Badge>
                      ) : d.status === 'provisioning' ? (
                        <Badge variant="muted">
                          <Clock className="mr-1 size-3" />
                          注册中
                        </Badge>
                      ) : d.status === 'failed' ? (
                        <Badge variant="danger">注册失败</Badge>
                      ) : (
                        <Badge variant="warning">
                          <Clock className="mr-1 size-3" />
                          待验证
                        </Badge>
                      )}
                    </td>
                    {multiAcs && (
                      <td className="px-4 py-3 text-muted-foreground">
                        {d.acsAccount?.name ?? '—'}
                      </td>
                    )}
                    <td className="px-4 py-3 text-muted-foreground">
                      {d.senderUsernames.length > 0 ? (
                        <span title={d.senderUsernames.map((u) => u.fullAddress).join('\n')}>
                          {d.senderUsernames.length} 个
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(d.lastCheckedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {needsConfig && (
                          <Button size="sm" asChild>
                            <Link to={`/settings/domains/new?id=${d.id}`}>{continueLabel}</Link>
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => verifyMut.mutate(d.id)}
                          disabled={verifyMut.isPending || isDeleting}
                        >
                          <RefreshCw className="mr-1 size-3" />
                          重新检测
                        </Button>
                        <button
                          type="button"
                          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                          // Disable this row's button while it's being deleted
                          // (avoid double-click) AND while another row is being
                          // deleted (the upstream LRO is single-flight-ish and
                          // overlapping deletes confuse users).
                          disabled={isDeleting || isDeletingOther}
                          title={isDeleting ? '正在删除，请稍候' : '删除域名'}
                          onClick={async () => {
                            const ok = await confirm({
                              title: '删除域名',
                              description: (
                                <>
                                  确定删除 <span className="font-mono">{d.domain}</span> 吗?该域名的发件能力将立即失效。删除过程通常需要 10–20 秒。
                                </>
                              ),
                              confirmLabel: '删除',
                              variant: 'danger',
                            });
                            if (!ok) return;
                            setDeletingId(d.id);
                            deleteMut.mutate(d.id);
                          }}
                        >
                          {isDeleting ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
