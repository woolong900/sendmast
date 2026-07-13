import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Mail,
  Truck,
  ShoppingCart,
  Save,
  Store,
  ArrowLeft,
  CheckCircle2,
  Pencil,
  Plus,
  Trash2,
  Clock,
  UserPlus,
} from 'lucide-react';
import { type IEmailTemplate } from 'easy-email-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { FilterSelect } from '@/components/ui/filter-select';
import { useToast } from '@/components/ui/toast';
import { cn, formatNumber } from '@/lib/utils';
import { api, apiErrMessage } from '@/lib/api';
import { applyMergePreviewSamples } from '@/lib/email-merge-preview';
import {
  SHOP_AUTOMATION_TYPES,
  SHOP_AUTOMATION_LABELS,
  SHOP_AUTOMATION_DEFAULT_SUBJECT,
  SHOP_AUTOMATION_DEFAULT_PREHEADER,
  abandonedRoundDefault,
  MAX_ABANDONED_ROUNDS,
  type CouponDiscountKind,
  type ShopAutomationType,
  type ShopAutomationView,
  type ShopConnectionView,
  type ShopCouponView,
  type SenderDomainView,
} from '@sendmast/shared';
import type { AutomationEmailContent } from './AutomationEmailEditor';

const AutomationEmailEditor = lazy(() =>
  import('./AutomationEmailEditor').then((m) => ({ default: m.AutomationEmailEditor })),
);

interface ShopConnectionsResponse {
  configured: boolean;
  connections: ShopConnectionView[];
}

const ICONS: Record<ShopAutomationType, typeof Mail> = {
  customer_registered: UserPlus,
  order_paid: Mail,
  order_shipped: Truck,
  abandoned_cart: ShoppingCart,
};

/** Soft tinted icon tile per flow. */
const ACCENTS: Record<ShopAutomationType, string> = {
  customer_registered: 'bg-violet-50 text-violet-600',
  order_paid: 'bg-emerald-50 text-emerald-600',
  order_shipped: 'bg-sky-50 text-sky-600',
  abandoned_cart: 'bg-amber-50 text-amber-600',
};

/** Shared input styling across the settings panel — matches FilterSelect's trigger. */
const FIELD = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';

const TRIGGERS: Record<ShopAutomationType, string> = {
  customer_registered: '当顾客注册店铺账户时立即发送',
  order_paid: '当买家完成支付时立即发送',
  order_shipped: '当订单发货时立即发送',
  abandoned_cart: '当订单创建后超过设定时间仍未支付时发送召回',
};

const EMPTY_FLOW_STATS = {
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  revenue: 0,
  currency: 'USD',
};

const DISCONNECTED_FLOWS: ShopAutomationView[] = SHOP_AUTOMATION_TYPES.map((type) => ({
  id: `disconnected-${type}`,
  type,
  enabled: false,
  templateId: null,
  html: null,
  designJson: null,
  thumbnail: null,
  preheader: null,
  senderDomainId: null,
  fromEmail: null,
  fromName: null,
  subject: null,
  couponCode: null,
  couponDiscountKind: null,
  couponDiscountValue: null,
  delayMinutes: type === 'abandoned_cart' ? 30 : 0,
  steps: [],
  stats: EMPTY_FLOW_STATS,
}));

export function AutomationsPage() {
  const { data, isLoading } = useQuery<ShopConnectionsResponse>({
    queryKey: ['shop-connections'],
    queryFn: async () => (await api.get('/api/integrations/shopyy')).data,
    refetchOnMount: 'always',
  });

  const active = (data?.connections ?? []).filter((c) => c.status === 'active');
  const [storeId, setStoreId] = useState<string | null>(null);
  const selected = active.find((c) => c.id === storeId) ?? active[0] ?? null;
  // Hide the page header/store picker while a flow is being edited so the
  // editor reads like other edit pages (back button + edited object name only).
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-6">
      {!editing && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">自动化</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              为店铺事件配置自动化邮件流程：买家下单、支付、发货时自动触发，无需手动发送。
            </p>
          </div>
        </div>
      )}

      {isLoading && <AutomationLoading />}

      {!isLoading && active.length === 0 && (
        <div className="space-y-4">
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 py-8 text-center">
              <Store className="size-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">尚未连接店铺</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  自动化任务可先查看，开启与配置需要先连接可用的 Shopyy 店铺。
                </p>
              </div>
              <Button asChild size="sm">
                <Link to="/settings/shop">前往连接店铺</Link>
              </Button>
            </CardContent>
          </Card>

          <DisabledFlowList />
        </div>
      )}

      {!isLoading && active.length > 0 && selected && (
        <div className="space-y-4">
          {active.length > 1 && !editing && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">店铺</span>
              <FilterSelect
                className="w-56"
                value={selected.id}
                onChange={setStoreId}
                options={active.map((c) => ({
                  value: c.id,
                  label: c.shopName ?? c.shopDomain ?? `店铺 #${c.externalStoreId}`,
                }))}
              />
            </div>
          )}
          <FlowList key={selected.id} connectionId={selected.id} onEditingChange={setEditing} />
        </div>
      )}
    </div>
  );
}

function DisabledFlowList() {
  return (
    <AutomationTable>
      {DISCONNECTED_FLOWS.map((a) => (
        <FlowTableRow
          key={a.id}
          connectionId=""
          automation={a}
          disabledReason="连接店铺后可配置并开启"
        />
      ))}
    </AutomationTable>
  );
}

function FlowList({
  connectionId,
  onEditingChange,
}: {
  connectionId: string;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editingType, setEditingType] = useState<ShopAutomationType | null>(null);
  useEffect(() => {
    onEditingChange?.(editingType !== null);
    return () => onEditingChange?.(false);
  }, [editingType, onEditingChange]);
  const automations = useQuery<ShopAutomationView[]>({
    queryKey: ['shop-automations', connectionId],
    queryFn: async () =>
      (await api.get(`/api/integrations/shopyy/${connectionId}/automations`)).data,
  });
  const domains = useQuery<SenderDomainView[]>({
    queryKey: ['sender-domains'],
    queryFn: async () => (await api.get('/api/sender-domains')).data,
  });

  const senderOptions = useMemo(() => {
    const verified =
      domains.data?.filter(
        (d) => d.status === 'verified' && d.emailChannel?.allowTransactional !== false,
      ) ?? [];
    return verified.flatMap((d) =>
      d.senderUsernames.map((u) => ({
        value: u.fullAddress,
        label: u.displayName ? `${u.displayName} <${u.fullAddress}>` : u.fullAddress,
        name: u.displayName?.trim() || u.username || u.fullAddress.split('@')[0],
      })),
    );
  }, [domains.data]);

  if (automations.isLoading) {
    return <AutomationLoading />;
  }

  const flows = automations.data ?? [];
  const editing = editingType ? flows.find((a) => a.type === editingType) : null;

  if (editing) {
    return (
      <FlowEditor
        connectionId={connectionId}
        automation={editing}
        senderOptions={senderOptions}
        onBack={() => setEditingType(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {senderOptions.length === 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-700">
          尚无已验证的发件邮箱，启用流程前请先在「发件域名」中完成验证。
        </p>
      )}
      <AutomationTable>
        {flows.map((a) => (
          <FlowTableRow
            key={a.id}
            connectionId={connectionId}
            automation={a}
            onEdit={() => setEditingType(a.type)}
          />
        ))}
      </AutomationTable>
    </div>
  );
}

function AutomationLoading() {
  return (
    <AutomationTable>
      {Array.from({ length: 4 }, (_, i) => (
        <tr key={i} className="border-b last:border-b-0">
          <td className="px-6 py-4 align-middle">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          </td>
          <td className="px-6 py-4 align-middle">
            <Skeleton className="h-5 w-14 rounded-full" />
          </td>
          <td className="px-6 py-4 align-middle">
            <div className="flex justify-end">
              <Skeleton className="h-4 w-8" />
            </div>
          </td>
          <td className="px-6 py-4 align-middle">
            <div className="flex justify-end">
              <Skeleton className="h-4 w-10" />
            </div>
          </td>
          <td className="px-6 py-4 align-middle">
            <div className="flex justify-end">
              <Skeleton className="h-4 w-10" />
            </div>
          </td>
          <td className="px-6 py-4 align-middle">
            <div className="flex justify-end">
              <Skeleton className="h-4 w-14" />
            </div>
          </td>
          <td className="px-6 py-4 align-middle">
            <div className="flex items-center justify-end gap-3">
              <Skeleton className="h-5 w-9 rounded-full" />
              <Skeleton className="size-7" />
            </div>
          </td>
        </tr>
      ))}
    </AutomationTable>
  );
}

function AutomationTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-6 py-3 text-left font-medium">名称</th>
              <th className="px-6 py-3 text-left font-medium">状态</th>
              <th className="px-6 py-3 text-right font-medium">已发送</th>
              <th className="px-6 py-3 text-right font-medium">打开率</th>
              <th className="px-6 py-3 text-right font-medium">点击率</th>
              <th className="px-6 py-3 text-right font-medium">销售额</th>
              <th className="px-6 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function formatMoney(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `${currency} ${Math.round(v)}`;
  }
}

/** Inline email content edited per flow / per recovery round. */
interface EmailContent {
  html: string | null;
  mjml: string | null;
  designJson: IEmailTemplate | null;
  thumbnail: string | null;
}

interface Round extends EmailContent {
  preheader: string;
  subject: string;
  couponCode: string;
  couponDiscountKind: CouponDiscountKind | null;
  couponDiscountValue: number | null;
  delayMinutes: number;
}

/** Thumbnail of an email's content; click to open the editor. */
function EmailThumb({
  thumbnail,
  html,
  onEdit,
}: {
  thumbnail: string | null;
  html: string | null;
  onEdit: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className="group relative block h-full min-h-[160px] w-full overflow-hidden rounded-xl border bg-muted/30 text-left shadow-sm"
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" className="h-full w-full object-cover object-top" />
      ) : html ? (
        <iframe
          title="email-thumb"
          srcDoc={applyMergePreviewSamples(html)}
          sandbox=""
          scrolling="no"
          className="pointer-events-none h-[300%] w-[300%] origin-top-left scale-[0.333] border-0 bg-white"
        />
      ) : (
        <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
          点击设置邮件内容
        </div>
      )}
      <div className="absolute inset-0 flex items-center justify-center gap-1 text-sm font-medium text-white opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
        <Pencil className="size-4" />
        编辑邮件
      </div>
    </button>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-2 block text-sm font-semibold text-foreground">{children}</span>;
}

/**
 * Email content block shared by single-template flows and recovery rounds:
 * a larger email thumbnail on the left, with sender / subject / preheader
 * stacked on the right. Collapses to a single column on narrow screens.
 */
function EmailContentBlock({
  thumbnail,
  html,
  onEdit,
  fromEmail,
  onFromEmail,
  senderOptions,
  subject,
  onSubject,
  preheader,
  onPreheader,
}: {
  thumbnail: string | null;
  html: string | null;
  onEdit: () => void;
  fromEmail: string;
  onFromEmail: (v: string) => void;
  senderOptions: { value: string; label: string; name: string }[];
  subject: string;
  onSubject: (v: string) => void;
  preheader: string;
  onPreheader: (v: string) => void;
}) {
  return (
    <div className="grid items-start gap-5 sm:[grid-template-columns:minmax(0,220px)_minmax(0,1fr)]">
      <div className="flex flex-col">
        <FieldLabel>邮件内容</FieldLabel>
        <div className="h-[188px]">
          <EmailThumb thumbnail={thumbnail} html={html} onEdit={onEdit} />
        </div>
      </div>
      <div className="min-w-0 space-y-3">
        <div>
          <FieldLabel>发件人</FieldLabel>
          <FilterSelect
            value={fromEmail}
            onChange={onFromEmail}
            placeholder="未选择"
            options={[
              { value: '', label: '未选择' },
              ...senderOptions.map((o) => ({ value: o.value, label: o.label })),
            ]}
          />
        </div>
        <label className="block">
          <FieldLabel>邮件主题</FieldLabel>
          <input
            className={cn(FIELD, 'truncate')}
            value={subject}
            placeholder="留空使用默认主题"
            onChange={(e) => onSubject(e.target.value)}
          />
        </label>
        <label className="block">
          <FieldLabel>
            内文预览 <span className="font-normal text-muted-foreground">（选填）</span>
          </FieldLabel>
          <input
            className={cn(FIELD, 'truncate')}
            value={preheader}
            placeholder="收件箱中显示在主题后的预览文字"
            onChange={(e) => onPreheader(e.target.value)}
          />
        </label>
      </div>
    </div>
  );
}

/** Picker label, e.g. "夏季促销（SUMMER）· 15% off" / "· 减 20". */
function couponOptionLabel(c: ShopCouponView): string {
  const base = c.name === c.code ? c.code : `${c.name}（${c.code}）`;
  if (c.discountKind === 'percent' && c.discountValue) return `${base} · ${c.discountValue}% off`;
  if (c.discountKind === 'amount' && c.discountValue) return `${base} · 减 ${c.discountValue}`;
  return base;
}

function CouponPicker({
  value,
  discountKind,
  discountValue,
  coupons,
  isError,
  onChange,
}: {
  value: string;
  discountKind: CouponDiscountKind | null;
  discountValue: number | null;
  coupons: ShopCouponView[] | undefined;
  isError: boolean;
  onChange: (patch: {
    couponCode: string;
    couponDiscountKind: CouponDiscountKind | null;
    couponDiscountValue: number | null;
  }) => void;
}) {
  const rows = coupons ?? [];
  return (
    <label className="block">
      <FieldLabel>
        优惠券 <span className="font-normal text-muted-foreground">（选填，展示在邮件中）</span>
      </FieldLabel>
      <FilterSelect
        value={value}
        placeholder="不使用优惠券"
        onChange={(code) => {
          const c = rows.find((x) => x.code === code);
          onChange({
            couponCode: code,
            // Snapshot the picked coupon's discount; keep the saved one if
            // re-selecting an off-list code.
            couponDiscountKind: c ? c.discountKind : code === value ? discountKind : null,
            couponDiscountValue: c ? c.discountValue : code === value ? discountValue : null,
          });
        }}
        options={[
          { value: '', label: '不使用优惠券' },
          // Keep a saved code selectable even if it's not in the live list.
          ...(value && !rows.some((c) => c.code === value) ? [{ value, label: value }] : []),
          ...rows.map((c) => ({
            value: c.code,
            label: couponOptionLabel(c),
          })),
        ]}
      />
      {isError && (
        <span className="mt-1 block text-xs text-amber-600">
          无法拉取店铺优惠券：请在 Shopyy 开发者后台为应用开通「优惠券」接口权限后重试。
        </span>
      )}
    </label>
  );
}

const MINUTES_PER_DAY = 1440;
/** Server cap on a round's delay (== 7 days). */
const MAX_DELAY_MINUTES = 10080;
/** Per-round default delays (minutes): 30m, 2h, 1d, 3d, 7d. */
const ROUND_DEFAULT_MINUTES = [30, 120, 1440, 4320, 10080];

/** Render a minute count as a human delay, e.g. 1530 -> "1天1小时30分钟". */
function formatDelay(m: number): string {
  const d = Math.floor(m / MINUTES_PER_DAY);
  const h = Math.floor((m % MINUTES_PER_DAY) / 60);
  const mm = m % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}小时`);
  if (mm) parts.push(`${mm}分钟`);
  return parts.join('') || '0分钟';
}

/** Days/hours/minutes editor over a single total-minutes value (capped at 7d). */
function DelayField({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const hours = Math.floor((minutes % MINUTES_PER_DAY) / 60);
  const mins = minutes % 60;
  const commit = (d: number, h: number, m: number) =>
    onChange(Math.min(MAX_DELAY_MINUTES, Math.max(0, d * MINUTES_PER_DAY + h * 60 + m)));
  const box = (label: string, value: number, max: number, on: (v: number) => void) => (
    <label className="flex items-center gap-1">
      <input
        type="number"
        min={0}
        max={max}
        className="h-9 w-16 rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        onChange={(e) => on(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      />
      <span className="text-muted-foreground">{label}</span>
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {box('天', days, 7, (v) => commit(v, hours, mins))}
      {box('小时', hours, 23, (v) => commit(days, v, mins))}
      {box('分钟', mins, 59, (v) => commit(days, hours, v))}
    </div>
  );
}

/** Initial rounds for abandoned_cart: stored steps, else a single default. */
function initialRounds(a: ShopAutomationView): Round[] {
  if (a.steps.length) {
    return a.steps.map((s, idx) => ({
      html: s.html,
      mjml: null,
      designJson: (s.designJson as IEmailTemplate | null) ?? null,
      thumbnail: s.thumbnail,
      preheader: s.preheader || abandonedRoundDefault(idx + 1).preheader,
      subject: s.subject || abandonedRoundDefault(idx + 1).subject,
      couponCode: s.couponCode ?? '',
      couponDiscountKind: s.couponDiscountKind,
      couponDiscountValue: s.couponDiscountValue,
      delayMinutes: s.delayMinutes,
    }));
  }
  return [
    {
      html: a.html,
      mjml: null,
      designJson: (a.designJson as IEmailTemplate | null) ?? null,
      thumbnail: a.thumbnail,
      preheader: a.preheader || abandonedRoundDefault(1).preheader,
      subject: a.subject || abandonedRoundDefault(1).subject,
      couponCode: '',
      couponDiscountKind: null,
      couponDiscountValue: null,
      delayMinutes: a.delayMinutes,
    },
  ];
}

function FlowTableRow({
  connectionId,
  automation,
  onEdit,
  disabledReason,
}: {
  connectionId: string;
  automation: ShopAutomationView;
  onEdit?: () => void;
  disabledReason?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const Icon = ICONS[automation.type];
  const isAbandoned = automation.type === 'abandoned_cart';
  const disabled = !!disabledReason;
  const configured = isAbandoned
    ? automation.steps.length >= 1 &&
      automation.steps.every((r) => !!r.html) &&
      !!automation.fromEmail
    : !!automation.html && !!automation.fromEmail;

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) =>
      api.patch(`/api/integrations/shopyy/${connectionId}/automations/${automation.type}`, {
        enabled,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop-automations', connectionId] });
      toast(automation.enabled ? '已关闭自动化流程' : '已启用自动化流程', 'success');
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const s = automation.stats;
  const denom = s.delivered || s.sent;
  const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : '—');

  return (
    <tr
      className={cn(
        'group border-b transition-colors last:border-b-0',
        disabled ? 'bg-muted/10' : 'cursor-pointer hover:bg-muted/30',
      )}
      onClick={disabled ? undefined : onEdit}
    >
      <td className="px-6 py-4 align-middle">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg',
              ACCENTS[automation.type],
            )}
          >
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground transition-colors group-hover:text-primary">
                {SHOP_AUTOMATION_LABELS[automation.type]}
              </span>
              {isAbandoned && <Badge variant="muted">{automation.steps.length || 1} 轮</Badge>}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
              {TRIGGERS[automation.type]}
            </div>
          </div>
        </div>
      </td>
      <td className="px-6 py-4 align-middle">
        {disabled ? (
          <Badge variant="muted">未连接</Badge>
        ) : automation.enabled ? (
          <Badge variant="success">已启用</Badge>
        ) : configured ? (
          <Badge variant="muted">已关闭</Badge>
        ) : (
          <Badge variant="warning">待配置</Badge>
        )}
      </td>
      <td className="px-6 py-4 align-middle text-right tabular-nums text-muted-foreground">
        {formatNumber(s.sent)}
      </td>
      <td className="px-6 py-4 align-middle text-right tabular-nums text-muted-foreground">
        {pct(s.opened, denom)}
      </td>
      <td className="px-6 py-4 align-middle text-right tabular-nums text-muted-foreground">
        {pct(s.clicked, denom)}
      </td>
      <td className="px-6 py-4 align-middle text-right tabular-nums font-medium text-emerald-600">
        {formatMoney(s.revenue, s.currency)}
      </td>
      <td className="px-6 py-4 align-middle">
        <div className="flex items-center justify-end gap-3" onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={automation.enabled}
            onCheckedChange={(next) => {
              if (disabled) {
                toast(disabledReason, 'info');
                return;
              }
              toggle.mutate(next);
            }}
            disabled={disabled || toggle.isPending}
          />
          <button
            type="button"
            onClick={onEdit}
            title={disabled ? disabledReason : configured ? '编辑' : '配置'}
            disabled={disabled}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Pencil className="size-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function FlowEditor({
  connectionId,
  automation,
  senderOptions,
  onBack,
}: {
  connectionId: string;
  automation: ShopAutomationView;
  senderOptions: { value: string; label: string; name: string }[];
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const isAbandoned = automation.type === 'abandoned_cart';
  const supportsCoupon = isAbandoned || automation.type === 'customer_registered';

  // Coupons are fetched live from the store for flows that can display one. The
  // query 400s when the app lacks the coupon API scope; we surface a hint then.
  const coupons = useQuery<ShopCouponView[]>({
    queryKey: ['shop-coupons', connectionId],
    queryFn: async () => (await api.get(`/api/integrations/shopyy/${connectionId}/coupons`)).data,
    enabled: supportsCoupon,
    retry: false,
  });

  const [enabled, setEnabled] = useState(automation.enabled);
  const [fromEmail, setFromEmail] = useState(automation.fromEmail ?? '');
  // Pre-fill subject/preview with the per-automation defaults when the merchant
  // hasn't customised them yet, so the editor shows what will actually be sent.
  const [subject, setSubject] = useState(
    automation.subject || SHOP_AUTOMATION_DEFAULT_SUBJECT[automation.type],
  );
  const [preheader, setPreheader] = useState(
    automation.preheader || SHOP_AUTOMATION_DEFAULT_PREHEADER[automation.type],
  );
  const [couponCode, setCouponCode] = useState(automation.couponCode ?? '');
  const [couponDiscountKind, setCouponDiscountKind] = useState<CouponDiscountKind | null>(
    automation.couponDiscountKind,
  );
  const [couponDiscountValue, setCouponDiscountValue] = useState<number | null>(
    automation.couponDiscountValue,
  );
  // Inline email content for single-template flows.
  const [content, setContent] = useState<EmailContent>(() => ({
    html: automation.html,
    mjml: null,
    designJson: (automation.designJson as IEmailTemplate | null) ?? null,
    thumbnail: automation.thumbnail,
  }));
  const [rounds, setRounds] = useState<Round[]>(() => initialRounds(automation));
  // Which email is being edited: 'single' for non-abandoned, a round index
  // otherwise; null when the editor is closed.
  const [editing, setEditing] = useState<number | 'single' | null>(null);

  const delaysIncreasing = rounds.every(
    (r, i) => i === 0 || r.delayMinutes > rounds[i - 1]!.delayMinutes,
  );
  const delaysInRange = rounds.every(
    (r) => r.delayMinutes >= 1 && r.delayMinutes <= MAX_DELAY_MINUTES,
  );
  const roundsValid = !isAbandoned || (rounds.length >= 1 && delaysIncreasing && delaysInRange);

  const updateRound = (i: number, patch: Partial<Round>) =>
    setRounds((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRound = () =>
    setRounds((rs) => {
      const last = rs[rs.length - 1]?.delayMinutes ?? 0;
      const def = ROUND_DEFAULT_MINUTES[rs.length] ?? last + MINUTES_PER_DAY;
      const prev = rs[rs.length - 1];
      return [
        ...rs,
        {
          // Seed the new round's content from the previous round so it starts
          // from a sensible design the merchant can tweak.
          html: prev?.html ?? null,
          mjml: prev?.mjml ?? null,
          designJson: prev?.designJson ?? null,
          thumbnail: prev?.thumbnail ?? null,
          // Subject/preview default to this round's own escalating copy.
          preheader: abandonedRoundDefault(rs.length + 1).preheader,
          subject: abandonedRoundDefault(rs.length + 1).subject,
          couponCode: '',
          couponDiscountKind: null,
          couponDiscountValue: null,
          // Keep strictly increasing even if earlier rounds were edited large.
          delayMinutes: Math.min(MAX_DELAY_MINUTES, Math.max(def, last + 1)),
        },
      ];
    });
  const removeRound = (i: number) => setRounds((rs) => rs.filter((_, idx) => idx !== i));

  const save = useMutation({
    mutationFn: async () => {
      const fromName = senderOptions.find((o) => o.value === fromEmail)?.name ?? null;
      const body: Record<string, unknown> = {
        enabled,
        fromEmail: fromEmail || null,
        fromName,
      };
      if (isAbandoned) {
        body.steps = rounds.map((r) => ({
          html: r.html,
          mjml: r.mjml,
          designJson: r.designJson,
          thumbnail: r.thumbnail,
          preheader: r.preheader.trim() || null,
          subject: r.subject.trim() || null,
          couponCode: r.couponCode || null,
          couponDiscountKind: r.couponCode ? r.couponDiscountKind : null,
          couponDiscountValue: r.couponCode ? r.couponDiscountValue : null,
          delayMinutes: r.delayMinutes,
        }));
      } else {
        body.html = content.html;
        body.mjml = content.mjml;
        body.designJson = content.designJson;
        body.thumbnail = content.thumbnail;
        body.preheader = preheader.trim() || null;
        body.subject = subject.trim() || null;
        if (automation.type === 'customer_registered') {
          body.couponCode = couponCode || null;
          body.couponDiscountKind = couponCode ? couponDiscountKind : null;
          body.couponDiscountValue = couponCode ? couponDiscountValue : null;
        }
      }
      return api.patch(
        `/api/integrations/shopyy/${connectionId}/automations/${automation.type}`,
        body,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop-automations', connectionId] });
      toast('已保存自动化流程', 'success');
      onBack();
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const configured = isAbandoned
    ? rounds.length >= 1 && rounds.every((r) => !!r.html) && !!fromEmail
    : !!content.html && !!fromEmail;

  // Email currently open in the editor (single flow vs a specific round).
  const editingContent: EmailContent | null =
    editing === 'single' ? content : typeof editing === 'number' ? (rounds[editing] ?? null) : null;

  const applyContent = (c: AutomationEmailContent) => {
    const patch = {
      html: c.html,
      mjml: c.mjml,
      designJson: c.designJson,
      thumbnail: c.thumbnail,
    };
    if (editing === 'single') setContent(patch);
    else if (typeof editing === 'number') updateRound(editing, patch);
  };

  return (
    <>
      {editing !== null && editingContent && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
              <p className="text-sm text-muted-foreground">正在加载邮件编辑器...</p>
            </div>
          }
        >
          <AutomationEmailEditor
            initialDesignJson={editingContent.designJson}
            initialHtml={editingContent.html}
            onClose={() => setEditing(null)}
            onApply={applyContent}
          />
        </Suspense>
      )}
      <div className="space-y-4 pb-4">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={onBack}
            aria-label="返回自动化"
            className="shrink-0"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-xl font-semibold">编辑{SHOP_AUTOMATION_LABELS[automation.type]}</h1>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{enabled ? '已启用' : '已关闭'}</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>

        <Card>
          <CardContent className="space-y-6 p-6">
            <p className="text-sm text-muted-foreground">{TRIGGERS[automation.type]}</p>

            {!isAbandoned && (
              <>
                <EmailContentBlock
                  thumbnail={content.thumbnail}
                  html={content.html}
                  onEdit={() => setEditing('single')}
                  fromEmail={fromEmail}
                  onFromEmail={setFromEmail}
                  senderOptions={senderOptions}
                  subject={subject}
                  onSubject={setSubject}
                  preheader={preheader}
                  onPreheader={setPreheader}
                />
                {automation.type === 'customer_registered' && (
                  <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                    <CouponPicker
                      value={couponCode}
                      discountKind={couponDiscountKind}
                      discountValue={couponDiscountValue}
                      coupons={coupons.data}
                      isError={coupons.isError}
                      onChange={(patch) => {
                        setCouponCode(patch.couponCode);
                        setCouponDiscountKind(patch.couponDiscountKind);
                        setCouponDiscountValue(patch.couponDiscountValue);
                      }}
                    />
                  </div>
                )}
              </>
            )}

            {isAbandoned && (
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
                  <Clock className="size-4 shrink-0" />
                  <span>召回节奏 · 最多 {MAX_ABANDONED_ROUNDS} 轮，延迟须逐轮递增</span>
                </div>
                {rounds.map((r, i) => {
                  const badDelay = i > 0 && r.delayMinutes <= rounds[i - 1]!.delayMinutes;
                  return (
                    <div key={i} className="rounded-xl border bg-card p-4">
                      <div className="mb-4 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-semibold text-primary">
                            {i + 1}
                          </span>
                          <span className="text-sm font-semibold">第 {i + 1} 轮召回</span>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            <Clock className="size-3" />
                            下单后 {formatDelay(r.delayMinutes)}
                          </span>
                        </div>
                        {rounds.length > 1 && (
                          <button
                            type="button"
                            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => removeRound(i)}
                            aria-label="删除该轮"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </div>

                      <EmailContentBlock
                        thumbnail={r.thumbnail}
                        html={r.html}
                        onEdit={() => setEditing(i)}
                        fromEmail={fromEmail}
                        onFromEmail={setFromEmail}
                        senderOptions={senderOptions}
                        subject={r.subject}
                        onSubject={(v) => updateRound(i, { subject: v })}
                        preheader={r.preheader}
                        onPreheader={(v) => updateRound(i, { preheader: v })}
                      />

                      <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2">
                        <CouponPicker
                          value={r.couponCode}
                          discountKind={r.couponDiscountKind}
                          discountValue={r.couponDiscountValue}
                          coupons={coupons.data}
                          isError={coupons.isError}
                          onChange={(patch) => updateRound(i, patch)}
                        />
                        <div>
                          <FieldLabel>下单后延迟</FieldLabel>
                          <DelayField
                            minutes={r.delayMinutes}
                            onChange={(m) => updateRound(i, { delayMinutes: m })}
                          />
                        </div>
                      </div>
                      {badDelay && (
                        <p className="mt-2 text-xs text-destructive">
                          该轮延迟必须大于上一轮（{formatDelay(rounds[i - 1]!.delayMinutes)}）。
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center justify-between border-t pt-5">
              <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                {configured && <CheckCircle2 className="size-3.5 text-emerald-600" />}
                {configured ? '已配置完成' : '请设置邮件内容与发件人后保存'}
              </span>
              <div className="flex items-center gap-2">
                {isAbandoned && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={rounds.length >= MAX_ABANDONED_ROUNDS}
                    onClick={addRound}
                  >
                    <Plus className="mr-1 size-4" />
                    添加一轮
                  </Button>
                )}
                <Button onClick={() => save.mutate()} disabled={save.isPending || !roundsValid}>
                  <Save className="mr-1 size-4" />
                  保存流程
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
