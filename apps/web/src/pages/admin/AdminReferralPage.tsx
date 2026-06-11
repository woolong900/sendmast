import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FilterSelect } from '@/components/ui/filter-select';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { Skeleton, TableSkeletonRows } from '@/components/ui/skeleton';
import { api, apiErrMessage } from '@/lib/api';
import { cn, formatDateTime, formatNumber } from '@/lib/utils';
import type {
  CommissionMonthlySummary,
  CommissionRecordView,
  ReferralChannelInput,
  ReferralChannelView,
  ReferralSettingView,
} from '@sendmast/shared';
import { REFERRAL_CODE_REGEX } from '@sendmast/shared';

/**
 * Single page that hosts the entire referral / commission admin surface.
 * Three tabs:
 *   1) 渠道  - CRUD on partner channels (code + name + payout info + active)
 *   2) 全局设置 - editable commission rate (percent)
 *   3) 返佣明细 - filter by month + channel, view rollup + detail, export CSV
 *
 * No data is mutated outside this page, so a single page is easier to find
 * than three separate sidebar entries.
 */

type TabId = 'channels' | 'settings' | 'commissions';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'channels', label: '推荐渠道' },
  { id: 'settings', label: '返佣比例' },
  { id: 'commissions', label: '返佣明细' },
];

export function AdminReferralPage() {
  const [tab, setTab] = useState<TabId>('channels');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">推荐返佣</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          管理推荐渠道、设置返佣比例,并按月导出返佣明细用于线下结算。 新注册用户通过{' '}
          <span className="font-mono">/signup?ref=&lt;推荐码&gt;</span> 落地后,
          后续每笔充值订单都会按当前比例计提返佣。
        </p>
      </div>

      <div className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm transition-colors',
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'channels' && <ChannelsTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'commissions' && <CommissionsTab />}
    </div>
  );
}

// ============================================================================
// Tab 1: Channels CRUD
// ============================================================================

const EMPTY_DRAFT: ReferralChannelInput & { id?: string } = {
  code: '',
  name: '',
  contact: '',
  payoutInfo: '',
  notes: '',
  active: true,
};

function ChannelsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<(ReferralChannelInput & { id?: string }) | null>(null);

  const { data: channels = [], isLoading } = useQuery<ReferralChannelView[]>({
    queryKey: ['admin', 'referral', 'channels'],
    queryFn: async () => (await api.get('/api/admin/referral/channels')).data,
  });

  const saveMut = useMutation({
    mutationFn: async (d: ReferralChannelInput & { id?: string }) => {
      const body: ReferralChannelInput = {
        code: d.code.trim().toUpperCase(),
        name: d.name.trim(),
        contact: d.contact?.trim() || null,
        payoutInfo: d.payoutInfo?.trim() || null,
        notes: d.notes?.trim() || null,
        active: d.active,
      };
      if (d.id) await api.put(`/api/admin/referral/channels/${d.id}`, body);
      else await api.post('/api/admin/referral/channels', body);
    },
    onSuccess: () => {
      toast('已保存', 'success');
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['admin', 'referral', 'channels'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/admin/referral/channels/${id}`),
    onSuccess: () => {
      toast('已删除', 'success');
      qc.invalidateQueries({ queryKey: ['admin', 'referral', 'channels'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  async function handleDelete(c: ReferralChannelView) {
    const ok = await confirm({
      title: '删除推荐渠道',
      description: (
        <span>
          删除 <b>{c.name}</b> (<span className="font-mono">{c.code}</span>) 后,
          通过该渠道注册的租户仍然存在,只是不再产生新的返佣。
          已有返佣记录的渠道不可删除,请改为「禁用」。
        </span>
      ),
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    deleteMut.mutate(c.id);
  }

  async function copyLink(code: string) {
    const base = window.location.origin;
    const link = `${base}/signup?ref=${code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('推荐链接已复制', 'success');
    } catch {
      toast('复制失败,请手动选择文本', 'error');
    }
  }

  const codeValid = draft ? REFERRAL_CODE_REGEX.test(draft.code.trim().toUpperCase()) : false;
  const draftValid = draft && codeValid && draft.name.trim().length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button onClick={() => setDraft({ ...EMPTY_DRAFT })} disabled={!!draft}>
          <Plus className="mr-1 size-4" />
          新增渠道
        </Button>
      </div>

      {draft && (
        <ChannelDraftCard
          draft={draft}
          codeValid={codeValid}
          draftValid={!!draftValid}
          saving={saveMut.isPending}
          onChange={setDraft}
          onSave={() => draftValid && saveMut.mutate(draft)}
          onCancel={() => setDraft(null)}
        />
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">推荐码</th>
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium">联系人</th>
                  <th className="px-4 py-3 font-medium">已邀注册</th>
                  <th className="px-4 py-3 font-medium">累计返佣</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && <TableSkeletonRows columns={7} />}
                {!isLoading && channels.length === 0 && !draft && (
                  <EmptyStateRow colSpan={7} title="暂无推荐渠道 — 点右上角「新增渠道」开始" />
                )}
                {channels.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{c.code}</td>
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.contact || '—'}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatNumber(c.referredAccountCount)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">¥{c.totalCommissionCny.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      {c.active ? (
                        <Badge variant="success">启用</Badge>
                      ) : (
                        <Badge variant="muted">已禁用</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => copyLink(c.code)}
                          title="复制推荐链接"
                        >
                          <Copy className="mr-1 size-3.5" />
                          推荐链接
                        </Button>
                        <button
                          type="button"
                          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                          onClick={() =>
                            setDraft({
                              id: c.id,
                              code: c.code,
                              name: c.name,
                              contact: c.contact ?? '',
                              payoutInfo: c.payoutInfo ?? '',
                              notes: c.notes ?? '',
                              active: c.active,
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
                          onClick={() => handleDelete(c)}
                          disabled={deleteMut.isPending || !!draft}
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
        </CardContent>
      </Card>
    </div>
  );
}

function ChannelDraftCard({
  draft,
  codeValid,
  draftValid,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ReferralChannelInput & { id?: string };
  codeValid: boolean;
  draftValid: boolean;
  saving: boolean;
  onChange: (d: ReferralChannelInput & { id?: string }) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ref-code">
              推荐码 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ref-code"
              value={draft.code}
              onChange={(e) => onChange({ ...draft, code: e.target.value.toUpperCase() })}
              placeholder="如 PARTNER01,4-24 位大写字母数字"
              autoComplete="off"
              className="font-mono"
            />
            {draft.code.trim() && !codeValid && (
              <p className="text-xs text-destructive">只允许大写字母和数字,长度 4-24 位</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-name">
              渠道名称 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ref-name"
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              placeholder="如 张三 / ACME 公司"
              autoComplete="off"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ref-contact">联系方式(可选)</Label>
          <Input
            id="ref-contact"
            value={draft.contact ?? ''}
            onChange={(e) => onChange({ ...draft, contact: e.target.value })}
            placeholder="电话 / 邮箱 / 微信号"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ref-payout">收款信息(可选)</Label>
          <Textarea
            id="ref-payout"
            value={draft.payoutInfo ?? ''}
            onChange={(e) => onChange({ ...draft, payoutInfo: e.target.value })}
            placeholder="开户行 / 卡号 / 户名,或支付宝 / 微信收款账号。结算时管理员从导出表里查阅。"
            rows={3}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ref-notes">备注(可选)</Label>
          <Textarea
            id="ref-notes"
            value={draft.notes ?? ''}
            onChange={(e) => onChange({ ...draft, notes: e.target.value })}
            placeholder="合作时间、对接人、特殊约定等"
            rows={2}
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(e) => onChange({ ...draft, active: e.target.checked })}
              disabled={saving}
            />
            启用(允许新注册落地)
          </label>
        </div>
        <div className="flex gap-2 pt-2">
          <Button onClick={onSave} disabled={!draftValid || saving}>
            <Save className="mr-1 size-4" />
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            <X className="mr-1 size-4" />
            取消
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Tab 2: Settings (global rate)
// ============================================================================

function SettingsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery<ReferralSettingView>({
    queryKey: ['admin', 'referral', 'settings'],
    queryFn: async () => (await api.get('/api/admin/referral/settings')).data,
  });
  const [rate, setRate] = useState<string>('');
  const current = data?.ratePercent ?? 15;
  const draftRate = rate === '' ? current : Number(rate);
  const dirty = rate !== '' && Number(rate) !== current;
  const valid = Number.isFinite(draftRate) && draftRate >= 0 && draftRate <= 100;

  const saveMut = useMutation({
    mutationFn: () => api.put('/api/admin/referral/settings', { ratePercent: draftRate }),
    onSuccess: () => {
      toast('返佣比例已更新', 'success');
      setRate('');
      qc.invalidateQueries({ queryKey: ['admin', 'referral', 'settings'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-32" />
          </div>
          <Skeleton className="h-9 w-20" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <div className="text-sm font-medium">当前返佣比例</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{current.toFixed(2)}%</div>
          {data?.updatedAt && (
            <div className="mt-1 text-xs text-muted-foreground">
              上次更新 {formatDateTime(data.updatedAt)}
            </div>
          )}
        </div>
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="rate-input">新比例(%)</Label>
          <div className="flex items-center gap-2">
            <Input
              id="rate-input"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder={current.toFixed(2)}
              className="w-32 tabular-nums"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          {!valid && <p className="text-xs text-destructive">取值范围 0-100</p>}
        </div>
        <div className="text-xs text-muted-foreground">
          注意:仅影响保存后<strong>新产生</strong>的返佣记录,
          已计提的返佣按当时的比例快照不会被改写。
        </div>
        <div>
          <Button onClick={() => saveMut.mutate()} disabled={!dirty || !valid || saveMut.isPending}>
            <Save className="mr-1 size-4" />
            {saveMut.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Tab 3: Commission detail + monthly export
// ============================================================================

/** Default month = current month in `YYYY-MM`. */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function CommissionsTab() {
  const toast = useToast();
  const [month, setMonth] = useState<string>(currentMonth());
  const [channelId, setChannelId] = useState<string>('');

  const { data: channels = [] } = useQuery<ReferralChannelView[]>({
    queryKey: ['admin', 'referral', 'channels'],
    queryFn: async () => (await api.get('/api/admin/referral/channels')).data,
  });

  const channelOptions = useMemo(
    () => [
      { value: '', label: '全部渠道' },
      ...channels.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })),
    ],
    [channels],
  );

  const filterKey = useMemo(() => ({ month, channelId }), [month, channelId]);

  const { data: summary } = useQuery<CommissionMonthlySummary>({
    queryKey: ['admin', 'referral', 'commissions', 'summary', filterKey.month],
    queryFn: async () =>
      (
        await api.get('/api/admin/referral/commissions/summary', {
          params: { month: filterKey.month },
        })
      ).data,
    enabled: !!filterKey.month,
  });

  const { data: detail = [], isLoading: detailLoading } = useQuery<CommissionRecordView[]>({
    queryKey: ['admin', 'referral', 'commissions', filterKey],
    queryFn: async () =>
      (
        await api.get('/api/admin/referral/commissions', {
          params: {
            month: filterKey.month,
            ...(filterKey.channelId ? { channelId: filterKey.channelId } : {}),
          },
        })
      ).data,
    enabled: !!filterKey.month,
  });

  const filteredSummary = useMemo(() => {
    if (!summary) return null;
    if (!channelId) return summary;
    const rows = summary.rows.filter((r) => r.channelId === channelId);
    return {
      ...summary,
      rows,
      totalOrderCount: rows.reduce((s, r) => s + r.orderCount, 0),
      totalOrderAmountCny: Math.round(rows.reduce((s, r) => s + r.orderAmountCny, 0) * 100) / 100,
      totalCommissionCny: Math.round(rows.reduce((s, r) => s + r.commissionCny, 0) * 100) / 100,
    };
  }, [summary, channelId]);

  async function exportCsv() {
    try {
      const r = await api.get('/api/admin/referral/commissions/export', {
        params: {
          month: filterKey.month,
          ...(filterKey.channelId ? { channelId: filterKey.channelId } : {}),
        },
        responseType: 'blob',
      });
      const blob = new Blob([r.data], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `commissions-${filterKey.month}${
        filterKey.channelId ? `-${filterKey.channelId.slice(0, 8)}` : ''
      }.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(apiErrMessage(err), 'error');
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="month-input">月份</Label>
            <Input
              id="month-input"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value || currentMonth())}
              className="w-44"
            />
          </div>
          <div className="space-y-1.5">
            <Label>渠道</Label>
            <FilterSelect
              value={channelId}
              onChange={(v) => setChannelId(v)}
              options={channelOptions}
              className="w-72"
            />
          </div>
          <Button
            className="ml-auto"
            onClick={exportCsv}
            disabled={!month || (filteredSummary?.totalOrderCount ?? 0) === 0}
            title={
              (filteredSummary?.totalOrderCount ?? 0) === 0 ? '当前筛选条件下没有可导出的记录' : ''
            }
          >
            <Download className="mr-1 size-4" />
            导出 CSV
          </Button>
        </CardContent>
      </Card>

      {filteredSummary && (
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryStat label="订单数" value={formatNumber(filteredSummary.totalOrderCount)} />
          <SummaryStat
            label="订单总额"
            value={`¥${filteredSummary.totalOrderAmountCny.toFixed(2)}`}
          />
          <SummaryStat
            label="返佣总额"
            value={`¥${filteredSummary.totalCommissionCny.toFixed(2)}`}
            highlight
          />
        </div>
      )}

      {filteredSummary && filteredSummary.rows.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              渠道汇总
            </div>
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">渠道</th>
                  <th className="px-4 py-2 font-medium">订单数</th>
                  <th className="px-4 py-2 font-medium">订单金额</th>
                  <th className="px-4 py-2 font-medium">返佣金额</th>
                </tr>
              </thead>
              <tbody>
                {filteredSummary.rows.map((r) => (
                  <tr key={r.channelId} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium">{r.channelName}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.channelCode}</div>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{formatNumber(r.orderCount)}</td>
                    <td className="px-4 py-2 tabular-nums">¥{r.orderAmountCny.toFixed(2)}</td>
                    <td className="px-4 py-2 font-medium tabular-nums">
                      ¥{r.commissionCny.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="border-b bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            订单明细
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">支付时间</th>
                  <th className="px-4 py-2 font-medium">渠道</th>
                  <th className="px-4 py-2 font-medium">租户</th>
                  <th className="px-4 py-2 font-medium">订单金额</th>
                  <th className="px-4 py-2 font-medium">费率</th>
                  <th className="px-4 py-2 font-medium">返佣</th>
                </tr>
              </thead>
              <tbody>
                {detailLoading && <TableSkeletonRows columns={6} cellClassName="px-4 py-3" />}
                {!detailLoading && detail.length === 0 && (
                  <EmptyStateRow colSpan={6} title="该月份暂无返佣记录" />
                )}
                {detail.map((d) => (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {formatDateTime(d.paidAt)}
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{d.channelName}</div>
                      <div className="font-mono text-xs text-muted-foreground">{d.channelCode}</div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{d.accountName}</div>
                      {d.accountOwnerEmail && (
                        <div className="text-xs text-muted-foreground">{d.accountOwnerEmail}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 tabular-nums">¥{d.orderAmountCny.toFixed(2)}</td>
                    <td className="px-4 py-2 tabular-nums text-muted-foreground">
                      {d.ratePercent.toFixed(2)}%
                    </td>
                    <td className="px-4 py-2 font-medium tabular-nums">
                      ¥{d.commissionCny.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div
          className={cn('mt-1 text-2xl font-semibold tabular-nums', highlight && 'text-primary')}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
