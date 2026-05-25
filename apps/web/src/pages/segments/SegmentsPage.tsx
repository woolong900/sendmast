import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Filter, Pencil, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, apiErrMessage } from '@/lib/api';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { formatNumber } from '@/lib/utils';
import type { SegmentView } from '@sendmast/shared';

export function SegmentsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();

  const list = useQuery<SegmentView[]>({
    queryKey: ['segments'],
    queryFn: async () => (await api.get('/api/segments')).data,
  });

  const refreshMut = useMutation({
    mutationFn: (id: string) => api.post(`/api/segments/${id}/refresh`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['segments'] });
      toast('已刷新人数', 'success');
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/segments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['segments'] });
      toast('已删除', 'success');
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">动态分群</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            基于属性、列表、标签和行为筛选联系人,创建活动时可直接选用。
          </p>
        </div>
        <Button onClick={() => navigate('/segments/new')}>
          <Plus className="mr-1 size-4" />
          创建分群
        </Button>
      </div>

      <UsageHint />

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-6 py-3 text-left font-medium">名称</th>
              <th className="px-6 py-3 text-left font-medium">规则数</th>
              <th className="px-6 py-3 text-left font-medium">匹配人数</th>
              <th className="px-6 py-3 text-left font-medium">更新时间</th>
              <th className="px-6 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={5} className="px-6 py-10 text-center text-muted-foreground">
                  加载中...
                </td>
              </tr>
            )}
            {!list.isLoading && (list.data?.length ?? 0) === 0 && (
              <EmptyStateRow colSpan={5} />
            )}
            {list.data?.map((s) => (
              <tr key={s.id} className="border-b last:border-b-0">
                <td className="px-6 py-4 align-middle">
                  <Link
                    to={`/segments/${s.id}/edit`}
                    className="font-medium text-foreground hover:underline"
                  >
                    {s.name}
                  </Link>
                  {s.description && (
                    <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                      {s.description}
                    </div>
                  )}
                </td>
                <td className="px-6 py-4 align-middle text-muted-foreground">
                  {s.definition.rules.length}
                </td>
                <td className="px-6 py-4 align-middle">
                  {s.cachedCount === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <Users className="size-3.5 text-muted-foreground" />
                      {formatNumber(s.cachedCount)}
                    </span>
                  )}
                  {s.cachedAt && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {new Date(s.cachedAt).toLocaleString('zh-CN')}
                    </div>
                  )}
                </td>
                <td className="px-6 py-4 align-middle text-muted-foreground">
                  {new Date(s.updatedAt).toLocaleString('zh-CN')}
                </td>
                <td className="px-6 py-4 align-middle">
                  <div className="flex items-center justify-end gap-1 text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => refreshMut.mutate(s.id)}
                      disabled={refreshMut.isPending}
                      className="rounded p-1.5 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                      title="刷新人数"
                    >
                      <RefreshCw
                        className={`size-4 ${refreshMut.isPending && refreshMut.variables === s.id ? 'animate-spin' : ''}`}
                      />
                    </button>
                    <Link
                      to={`/segments/${s.id}/edit`}
                      className="rounded p-1.5 transition-colors hover:bg-muted hover:text-foreground"
                      title="编辑"
                    >
                      <Pencil className="size-4" />
                    </Link>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await confirm({
                          title: '删除该分群？',
                          description: `若有活动正在引用此分群将无法删除。`,
                          variant: 'danger',
                          confirmLabel: '删除',
                        });
                        if (ok) deleteMut.mutate(s.id);
                      }}
                      className="rounded p-1.5 transition-colors hover:bg-muted hover:text-destructive"
                      title="删除"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UsageHint() {
  return (
    <div className="flex gap-3 rounded-lg border border-blue-100 bg-blue-50/60 p-4 text-sm text-blue-900">
      <Filter className="mt-0.5 size-4 shrink-0 text-blue-600" />
      <div className="space-y-1">
        <div className="font-medium">什么是动态分群？</div>
        <ul className="list-disc space-y-0.5 pl-5 text-blue-800/90">
          <li>分群是基于规则的"动态名单",联系人变更时自动重新匹配,无需手动维护</li>
          <li>所有规则用 AND 组合;需要 OR 时请建多个分群</li>
          <li>支持按属性(国家、性别、语言)、列表成员、自定义标签、注册时间和行为(打开/点击)筛选</li>
          <li>创建活动时,目标可以同时选"列表 + 分群",最终发送对象为并集去重</li>
        </ul>
      </div>
    </div>
  );
}
