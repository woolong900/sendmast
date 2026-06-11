import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X, Check, RefreshCw, Pencil } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { Skeleton, TableSkeletonRows } from '@/components/ui/skeleton';
import { api, apiErrMessage } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/utils';
import type {
  FxRateView,
  QuotaPricingTierInput,
  QuotaPricingTierView,
} from '@sendmast/shared';

interface DraftRow extends QuotaPricingTierInput {
  /** Tier id when editing an existing row, undefined for the "new" row. */
  id?: string;
}

const EMPTY_DRAFT: DraftRow = {
  emails: 10000,
  priceUsd: 18,
  active: true,
  sortOrder: 100,
};

/**
 * Admin CRUD for the 9-tier pricing table. Inline editing — single draft
 * slot at a time so we never have two parallel edits competing for the
 * same row id. New row is pinned to the bottom.
 */
export function AdminQuotaTiersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const { data: tiers = [], isLoading } = useQuery<QuotaPricingTierView[]>({
    queryKey: ['admin', 'quota-tiers'],
    queryFn: async () => (await api.get('/api/admin/quota-tiers')).data,
  });

  const { data: fx } = useQuery<FxRateView>({
    queryKey: ['fx', 'usd-cny'],
    queryFn: async () => (await api.get('/api/fx/usd-cny')).data,
  });

  const refreshFxMut = useMutation<FxRateView>({
    mutationFn: async () => (await api.post('/api/admin/fx/refresh')).data,
    onSuccess: (data) => {
      qc.setQueryData(['fx', 'usd-cny'], data);
      toast(`汇率已刷新: 1 USD = ¥${data.rate.toFixed(4)}`, 'success');
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const saveMut = useMutation({
    mutationFn: async (d: DraftRow) => {
      const body: QuotaPricingTierInput = {
        emails: d.emails,
        priceUsd: d.priceUsd,
        active: d.active,
        sortOrder: d.sortOrder,
      };
      if (d.id) await api.put(`/api/admin/quota-tiers/${d.id}`, body);
      else await api.post('/api/admin/quota-tiers', body);
    },
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['admin', 'quota-tiers'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const toggleMut = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      api.patch(`/api/admin/quota-tiers/${input.id}/active`, { active: input.active }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'quota-tiers'] }),
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/admin/quota-tiers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'quota-tiers'] }),
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  async function handleDelete(t: QuotaPricingTierView) {
    const ok = await confirm({
      title: '删除档位',
      description: (
        <span>
          删除 <b>+{formatNumber(t.emails)}封</b> 档位?已支付的历史订单不会受影响,但该档位将不再出现在购买弹窗中。
        </span>
      ),
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    deleteMut.mutate(t.id);
  }

  const draftValid =
    draft &&
    draft.emails > 0 &&
    draft.priceUsd >= 0 &&
    Number.isFinite(draft.sortOrder);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">套餐档位</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理「购买额度」弹窗里展示的购买档位。价格 USD 标价,下单时按当前汇率换算成 CNY 喂给收钱吧(支持支付宝/微信)。停用的档位不会出现在用户端,但历史订单仍可读。
          </p>
        </div>
        <Button
          onClick={() => setDraft({ ...EMPTY_DRAFT })}
          disabled={!!draft}
        >
          <Plus className="mr-1 size-4" />
          新增档位
        </Button>
      </div>

      <Card>
        <CardContent className="flex items-center justify-between p-4 text-sm">
          <div className="space-y-0.5">
            <div className="font-medium text-foreground">
              {fx ? (
                <>
                  汇率: 1 USD ≈{' '}
                  <span className="tabular-nums">¥{fx.rate.toFixed(4)}</span>
                </>
              ) : (
                <Skeleton className="h-4 w-40" />
              )}
            </div>
            {fx && (
              <div className="text-xs text-muted-foreground">
                {fx.source === 'manual' ? '管理员手动刷新' : 'Frankfurter (ECB)'} ·
                上次拉取 {formatDateTime(fx.fetchedAt)}
              </div>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshFxMut.mutate()}
            disabled={refreshFxMut.isPending}
          >
            <RefreshCw
              className={`mr-1 size-4 ${refreshFxMut.isPending ? 'animate-spin' : ''}`}
            />
            刷新汇率
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">购买额度</th>
                <th className="px-4 py-3 font-medium">USD 售价</th>
                <th className="px-4 py-3 font-medium">USD 单价</th>
                <th className="px-4 py-3 font-medium">排序</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={6} />}
              {!isLoading && tiers.length === 0 && !draft && (
                <EmptyStateRow colSpan={6} />
              )}
              {tiers.map((t) =>
                draft?.id === t.id ? (
                  <DraftRowView
                    key={t.id}
                    draft={draft}
                    onChange={setDraft}
                    onCancel={() => setDraft(null)}
                    onSave={() => draftValid && saveMut.mutate(draft)}
                    saving={saveMut.isPending}
                  />
                ) : (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium tabular-nums">
                      +{formatNumber(t.emails)}封
                    </td>
                    <td className="px-4 py-3 tabular-nums">US${t.priceUsd}</td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      US${t.unitPriceUsd}/封
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {t.sortOrder}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => toggleMut.mutate({ id: t.id, active: !t.active })}
                        disabled={toggleMut.isPending}
                        className="cursor-pointer"
                      >
                        {t.active ? (
                          <Badge variant="success">启用</Badge>
                        ) : (
                          <Badge variant="muted">停用</Badge>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                          onClick={() =>
                            setDraft({
                              id: t.id,
                              emails: t.emails,
                              priceUsd: t.priceUsd,
                              active: t.active,
                              sortOrder: t.sortOrder,
                            })
                          }
                          disabled={!!draft}
                          title="编辑"
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                          onClick={() => handleDelete(t)}
                          disabled={deleteMut.isPending || !!draft}
                          title="删除档位"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
              {draft && !draft.id && (
                <DraftRowView
                  draft={draft}
                  onChange={setDraft}
                  onCancel={() => setDraft(null)}
                  onSave={() => draftValid && saveMut.mutate(draft)}
                  saving={saveMut.isPending}
                />
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function DraftRowView({
  draft,
  onChange,
  onCancel,
  onSave,
  saving,
}: {
  draft: DraftRow;
  onChange: (d: DraftRow) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <tr className="border-b bg-primary/5 last:border-0">
      <td className="px-4 py-3">
        <input
          type="number"
          min={1}
          className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm"
          value={draft.emails}
          onChange={(e) => onChange({ ...draft, emails: Number(e.target.value) })}
          disabled={saving}
        />
      </td>
      <td className="px-4 py-3">
        <input
          type="number"
          min={0}
          step={0.01}
          className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm"
          value={draft.priceUsd}
          onChange={(e) => onChange({ ...draft, priceUsd: Number(e.target.value) })}
          disabled={saving}
        />
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">—</td>
      <td className="px-4 py-3">
        <input
          type="number"
          step={10}
          className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm"
          value={draft.sortOrder}
          onChange={(e) => onChange({ ...draft, sortOrder: Number(e.target.value) })}
          disabled={saving}
        />
      </td>
      <td className="px-4 py-3">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => onChange({ ...draft, active: e.target.checked })}
            disabled={saving}
          />
          启用
        </label>
      </td>
      <td className="px-4 py-3">
        <div className="flex gap-1">
          <Button size="sm" onClick={onSave} disabled={saving}>
            <Check className="mr-1 size-3.5" />
            保存
          </Button>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
            <X className="mr-1 size-3.5" />
            取消
          </Button>
        </div>
      </td>
    </tr>
  );
}
