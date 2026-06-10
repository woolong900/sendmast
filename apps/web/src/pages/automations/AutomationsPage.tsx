import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Mail,
  Truck,
  ShoppingCart,
  Save,
  Store,
  ChevronDown,
  Workflow,
  CheckCircle2,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from 'lucide-react';
import { type IEmailTemplate } from 'easy-email-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { api, apiErrMessage } from '@/lib/api';
import {
  SHOP_AUTOMATION_LABELS,
  MAX_ABANDONED_ROUNDS,
  type CouponDiscountKind,
  type FlowStatsView,
  type ShopAutomationType,
  type ShopAutomationView,
  type ShopConnectionView,
  type ShopCouponView,
  type SenderDomainView,
} from '@sendmast/shared';
import { AutomationEmailEditor, type AutomationEmailContent } from './AutomationEmailEditor';

interface ShopConnectionsResponse {
  configured: boolean;
  connections: ShopConnectionView[];
}

const ICONS: Record<ShopAutomationType, typeof Mail> = {
  order_paid: Mail,
  order_shipped: Truck,
  abandoned_cart: ShoppingCart,
};

/** Colour accent per flow, Omnisend-style coloured leading badge. */
const ACCENTS: Record<ShopAutomationType, string> = {
  order_paid: 'bg-emerald-100 text-emerald-700',
  order_shipped: 'bg-sky-100 text-sky-700',
  abandoned_cart: 'bg-amber-100 text-amber-700',
};

const TRIGGERS: Record<ShopAutomationType, string> = {
  order_paid: '当买家完成支付时立即发送',
  order_shipped: '当订单发货时立即发送',
  abandoned_cart: '当订单创建后超过设定时间仍未支付时发送召回',
};

const DESCRIPTIONS: Record<ShopAutomationType, string> = {
  order_paid: '买家完成支付后立即发送，可用 {{order_no}}、{{order_total}} 等变量。',
  order_shipped: '订单发货后立即发送，可用 {{tracking_url}} 物流追踪链接。',
  abandoned_cart:
    '订单创建后等待设定的分钟数，若买家仍未完成支付则发送召回邮件；期间已支付则自动跳过。',
};

export function AutomationsPage() {
  const { data, isLoading } = useQuery<ShopConnectionsResponse>({
    queryKey: ['shop-connections'],
    queryFn: async () => (await api.get('/api/integrations/shopyy')).data,
  });

  const active = (data?.connections ?? []).filter((c) => c.status === 'active');
  const [storeId, setStoreId] = useState<string | null>(null);
  const selected = active.find((c) => c.id === storeId) ?? active[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
          <Workflow className="size-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">自动化</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            为店铺事件配置自动化邮件流程：买家下单、支付、发货时自动触发，无需手动发送。
          </p>
        </div>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">加载中...</CardContent>
        </Card>
      )}

      {!isLoading && active.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Store className="size-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">尚未连接店铺</p>
              <p className="mt-1 text-sm text-muted-foreground">
                自动化邮件依赖店铺事件触发，请先连接你的 Shopyy 店铺。
              </p>
            </div>
            <Button asChild size="sm">
              <Link to="/settings/shop">前往连接店铺</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && active.length > 0 && selected && (
        <div className="space-y-4">
          {active.length > 1 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">店铺</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={selected.id}
                onChange={(e) => setStoreId(e.target.value)}
              >
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.shopName ?? c.shopDomain ?? `店铺 #${c.externalStoreId}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <FlowList connectionId={selected.id} />
        </div>
      )}
    </div>
  );
}

function FlowList({ connectionId }: { connectionId: string }) {
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
    const verified = domains.data?.filter((d) => d.status === 'verified') ?? [];
    return verified.flatMap((d) =>
      d.senderUsernames.map((u) => ({
        value: u.fullAddress,
        label: u.displayName ? `${u.displayName} <${u.fullAddress}>` : u.fullAddress,
        name: u.displayName?.trim() || u.username || u.fullAddress.split('@')[0],
      })),
    );
  }, [domains.data]);

  if (automations.isLoading) {
    return <p className="text-sm text-muted-foreground">加载自动化流程...</p>;
  }

  return (
    <div className="space-y-3">
      {senderOptions.length === 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-700">
          尚无已验证的发件邮箱，启用流程前请先在「发件域名」中完成验证。
        </p>
      )}
      {(automations.data ?? []).map((a) => (
        <FlowCard
          key={a.id}
          connectionId={connectionId}
          automation={a}
          senderOptions={senderOptions}
        />
      ))}
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

function FlowStats({ stats }: { stats: FlowStatsView }) {
  const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : '—');
  const items = [
    { label: '已发送', value: String(stats.sent) },
    { label: '送达', value: String(stats.delivered) },
    { label: '打开率', value: pct(stats.opened, stats.delivered || stats.sent) },
    { label: '点击率', value: pct(stats.clicked, stats.delivered || stats.sent) },
    { label: '销售额', value: formatMoney(stats.revenue, stats.currency) },
  ];
  return (
    <div className="flex items-stretch divide-x divide-border overflow-hidden rounded-lg border bg-muted/20">
      {items.map((it) => (
        <div key={it.label} className="flex-1 px-2 py-2.5 text-center">
          <div className="text-[15px] font-semibold leading-none tabular-nums">{it.value}</div>
          <div className="mt-1.5 text-[11px] text-muted-foreground">{it.label}</div>
        </div>
      ))}
    </div>
  );
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
      className="group relative block aspect-[16/10] max-h-64 w-full overflow-hidden rounded-lg border bg-muted/30 text-left"
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" className="h-full w-full object-cover object-top" />
      ) : html ? (
        <iframe
          title="email-thumb"
          srcDoc={html}
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

/** Picker label, e.g. "夏季促销（SUMMER）· 15% off" / "· 减 20". */
function couponOptionLabel(c: ShopCouponView): string {
  const base = c.name === c.code ? c.code : `${c.name}（${c.code}）`;
  if (c.discountKind === 'percent' && c.discountValue) return `${base} · ${c.discountValue}% off`;
  if (c.discountKind === 'amount' && c.discountValue) return `${base} · 减 ${c.discountValue}`;
  return base;
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
function DelayField({
  minutes,
  onChange,
}: {
  minutes: number;
  onChange: (m: number) => void;
}) {
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
    return a.steps.map((s) => ({
      html: s.html,
      mjml: null,
      designJson: (s.designJson as IEmailTemplate | null) ?? null,
      thumbnail: s.thumbnail,
      preheader: s.preheader ?? '',
      subject: s.subject ?? '',
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
      preheader: a.preheader ?? '',
      subject: a.subject ?? '',
      couponCode: '',
      couponDiscountKind: null,
      couponDiscountValue: null,
      delayMinutes: a.delayMinutes,
    },
  ];
}

function FlowCard({
  connectionId,
  automation,
  senderOptions,
}: {
  connectionId: string;
  automation: ShopAutomationView;
  senderOptions: { value: string; label: string; name: string }[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const Icon = ICONS[automation.type];
  const isAbandoned = automation.type === 'abandoned_cart';

  // Coupons are fetched live from the store (only for the abandoned flow). The
  // query 400s when the app lacks the coupon API scope; we surface a hint then.
  const coupons = useQuery<ShopCouponView[]>({
    queryKey: ['shop-coupons', connectionId],
    queryFn: async () => (await api.get(`/api/integrations/shopyy/${connectionId}/coupons`)).data,
    enabled: isAbandoned,
    retry: false,
    staleTime: 60_000,
  });

  const [enabled, setEnabled] = useState(automation.enabled);
  const [fromEmail, setFromEmail] = useState(automation.fromEmail ?? '');
  const [subject, setSubject] = useState(automation.subject ?? '');
  const [preheader, setPreheader] = useState(automation.preheader ?? '');
  // Inline email content for single-template flows (order paid / shipped).
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
  // Configured flows start collapsed; unconfigured ones expand to guide setup.
  const [open, setOpen] = useState(!automation.html);

  const delaysIncreasing = rounds.every(
    (r, i) => i === 0 || r.delayMinutes > rounds[i - 1]!.delayMinutes,
  );
  const delaysInRange = rounds.every((r) => r.delayMinutes >= 1 && r.delayMinutes <= MAX_DELAY_MINUTES);
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
          preheader: '',
          subject: '',
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
      }
      return api.patch(
        `/api/integrations/shopyy/${connectionId}/automations/${automation.type}`,
        body,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop-automations', connectionId] });
      toast('已保存自动化流程', 'success');
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const configured = isAbandoned
    ? rounds.length >= 1 && rounds.every((r) => !!r.html) && !!fromEmail
    : !!content.html && !!fromEmail;

  // Email currently open in the editor (single flow vs a specific round).
  const editingContent: EmailContent | null =
    editing === 'single'
      ? content
      : typeof editing === 'number'
        ? rounds[editing] ?? null
        : null;

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

  const editorTitle =
    SHOP_AUTOMATION_LABELS[automation.type] +
    (typeof editing === 'number' ? ` · 第 ${editing + 1} 轮` : '');

  return (
    <>
      {editing !== null && editingContent && (
        <AutomationEmailEditor
          title={editorTitle}
          initialDesignJson={editingContent.designJson}
          initialHtml={editingContent.html}
          onClose={() => setEditing(null)}
          onApply={applyContent}
        />
      )}
      <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-3 p-4">
          <div
            className={cn(
              'flex size-11 shrink-0 items-center justify-center rounded-xl',
              ACCENTS[automation.type],
            )}
          >
            <Icon className="size-5" />
          </div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[15px] font-semibold">
                  {SHOP_AUTOMATION_LABELS[automation.type]}
                </span>
                {automation.enabled ? (
                  <Badge variant="success">已启用</Badge>
                ) : (
                  <Badge variant="muted">已关闭</Badge>
                )}
                {isAbandoned && (
                  <Badge variant="muted">{automation.steps.length || 1} 轮</Badge>
                )}
                {!configured && <Badge variant="warning">待配置</Badge>}
              </div>
              <div className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
                <Zap className="size-3 shrink-0" />
                <span className="truncate">{TRIGGERS[automation.type]}</span>
              </div>
            </div>
            <ChevronDown
              className={cn(
                'ml-auto size-4 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="px-4 pb-4">
          <FlowStats stats={automation.stats} />
        </div>

        {open && (
          <div className="space-y-3 border-t px-4 py-4">
            <p className="text-xs text-muted-foreground">{DESCRIPTIONS[automation.type]}</p>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">发件邮箱</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={fromEmail}
                onChange={(e) => setFromEmail(e.target.value)}
              >
                <option value="">未选择</option>
                {senderOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            {!isAbandoned && (
              <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                <div className="space-y-1 text-xs">
                  <span className="text-muted-foreground">邮件内容</span>
                  <EmailThumb
                    thumbnail={content.thumbnail}
                    html={content.html}
                    onEdit={() => setEditing('single')}
                  />
                </div>
                <div className="space-y-3">
                  <label className="block space-y-1 text-xs">
                    <span className="text-muted-foreground">邮件主题</span>
                    <input
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={subject}
                      placeholder="留空使用默认主题"
                      onChange={(e) => setSubject(e.target.value)}
                    />
                  </label>
                  <label className="block space-y-1 text-xs">
                    <span className="text-muted-foreground">内文预览（选填）</span>
                    <input
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={preheader}
                      placeholder="收件箱中显示在主题后的预览文字"
                      onChange={(e) => setPreheader(e.target.value)}
                    />
                  </label>
                </div>
              </div>
            )}

            {isAbandoned && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">召回轮次（最多 {MAX_ABANDONED_ROUNDS} 轮，延迟从下单时算起，须逐轮递增）</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={rounds.length >= MAX_ABANDONED_ROUNDS}
                    onClick={addRound}
                  >
                    <Plus className="mr-1 size-3.5" />
                    添加一轮
                  </Button>
                </div>
                {rounds.map((r, i) => {
                  const badDelay = i > 0 && r.delayMinutes <= rounds[i - 1]!.delayMinutes;
                  return (
                    <div key={i} className="rounded-lg border bg-muted/20 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                            {i + 1}
                          </span>
                          <span className="text-sm font-medium">第 {i + 1} 轮召回</span>
                          <span className="text-xs text-muted-foreground">
                            · 下单后 {formatDelay(r.delayMinutes)}
                          </span>
                        </div>
                        {rounds.length > 1 && (
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => removeRound(i)}
                            aria-label="删除该轮"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1 text-xs">
                          <span className="text-muted-foreground">邮件内容</span>
                          <EmailThumb
                            thumbnail={r.thumbnail}
                            html={r.html}
                            onEdit={() => setEditing(i)}
                          />
                        </div>
                        <div className="space-y-3">
                          <label className="block space-y-1 text-xs">
                            <span className="text-muted-foreground">邮件主题</span>
                            <input
                              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                              value={r.subject}
                              placeholder="留空使用默认主题"
                              onChange={(e) => updateRound(i, { subject: e.target.value })}
                            />
                          </label>
                          <label className="block space-y-1 text-xs">
                            <span className="text-muted-foreground">内文预览（选填）</span>
                            <input
                              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                              value={r.preheader}
                              placeholder="收件箱中显示在主题后的预览文字"
                              onChange={(e) => updateRound(i, { preheader: e.target.value })}
                            />
                          </label>
                        </div>
                        <label className="space-y-1 text-xs sm:col-span-2">
                          <span className="text-muted-foreground">优惠券（可选，选择后展示在邮件中）</span>
                          <select
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                            value={r.couponCode}
                            onChange={(e) => {
                              const code = e.target.value;
                              const c = (coupons.data ?? []).find((x) => x.code === code);
                              updateRound(i, {
                                couponCode: code,
                                // Snapshot the picked coupon's discount; keep the
                                // saved one if re-selecting an off-list code.
                                couponDiscountKind: c
                                  ? c.discountKind
                                  : code === r.couponCode
                                    ? r.couponDiscountKind
                                    : null,
                                couponDiscountValue: c
                                  ? c.discountValue
                                  : code === r.couponCode
                                    ? r.couponDiscountValue
                                    : null,
                              });
                            }}
                          >
                            <option value="">不使用优惠券</option>
                            {/* Keep a saved code selectable even if it's not in the live list. */}
                            {r.couponCode &&
                              !(coupons.data ?? []).some((c) => c.code === r.couponCode) && (
                                <option value={r.couponCode}>{r.couponCode}</option>
                              )}
                            {(coupons.data ?? []).map((c) => (
                              <option key={c.code} value={c.code}>
                                {couponOptionLabel(c)}
                              </option>
                            ))}
                          </select>
                          {coupons.isError && (
                            <span className="text-amber-600">
                              无法拉取店铺优惠券：请在 Shopyy 开发者后台为应用开通「优惠券」接口权限后重试。
                            </span>
                          )}
                        </label>
                        <div className="space-y-1 text-xs sm:col-span-2">
                          <span className="text-muted-foreground">下单后延迟</span>
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

            <div className="flex items-center justify-between border-t pt-4">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {configured && <CheckCircle2 className="size-3.5 text-emerald-600" />}
                {configured ? '已配置完成' : '请设置邮件内容与发件邮箱后保存'}
              </span>
              <Button
                size="sm"
                onClick={() => save.mutate()}
                disabled={save.isPending || !roundsValid}
              >
                <Save className="mr-1 size-4" />
                保存
              </Button>
            </div>
          </div>
        )}
      </CardContent>
      </Card>
    </>
  );
}
