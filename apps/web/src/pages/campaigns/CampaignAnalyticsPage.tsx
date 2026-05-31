import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatNumber, formatPercent } from '@/lib/utils';

interface AnalyticsView {
  campaignId: string;
  totals: {
    recipients: number;
    sent: number;
    delivered: number;
    failed: number;
    pending: number;
    uniqueOpens: number;
    uniqueClicks: number;
    bounces: number;
    bouncesHard: number;
    complaints: number;
    unsubscribes: number;
  };
  rates: {
    delivery: number;
    uniqueOpen: number;
    uniqueClick: number;
    bounce: number;
    bounceHard: number;
    pending: number;
    complaint: number;
    unsubscribe: number;
  };
  funnel: Array<{ step: string; value: number; pct: number }>;
}

interface CampaignDetail {
  id: string;
  name: string;
  sentAt: string | null;
  utmEnabled: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

const FUNNEL_LABEL: Record<string, string> = {
  sent: '发送',
  delivered: '送达',
  opened: '打开',
  clicked: '点击',
  ordered: '下单',
};

const FUNNEL_COUNT_LABEL: Record<string, string> = {
  sent: '发送数',
  delivered: '送达数',
  opened: '打开人数',
  clicked: '点击人数',
  ordered: '下单人数',
};

const FUNNEL_ORDER = ['sent', 'delivered', 'opened', 'clicked', 'ordered'] as const;

export function CampaignAnalyticsPage() {
  const { id } = useParams<{ id: string }>();

  const detail = useQuery<CampaignDetail>({
    queryKey: ['campaigns', id],
    queryFn: async () => (await api.get(`/api/campaigns/${id}`)).data,
    enabled: !!id,
  });

  const analytics = useQuery<AnalyticsView>({
    queryKey: ['analytics', id],
    queryFn: async () => (await api.get(`/api/analytics/campaigns/${id}`)).data,
    enabled: !!id,
    refetchInterval: 5000,
  });

  if (analytics.isLoading || detail.isLoading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }
  if (!analytics.data || !detail.data) return null;

  const { totals, rates, funnel } = analytics.data;
  const failureRate =
    totals.recipients > 0 ? totals.failed / totals.recipients : 0;
  const utmRows = collectUtm(detail.data);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" asChild className="shrink-0">
          <Link to={`/campaigns/${id}`} aria-label="返回活动详情">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-xl font-semibold">{detail.data.name}</h1>
      </div>

      {/* Single outer card hosting all summary metrics + UTM */}
      <Card>
        <CardContent className="space-y-3 p-4">
          {/* Row 1 — engagement headline metrics. Each card drills into the
              matching tab on /recipients. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              to={recipientLink(id, 'sent')}
              label="发送数"
              value={formatNumber(totals.sent)}
            />
            <MetricCard
              to={recipientLink(id, 'delivered')}
              label="送达率"
              value={formatPercent(rates.delivery)}
              hint={`(送达数 ${formatNumber(totals.delivered)})`}
            />
            <MetricCard
              to={recipientLink(id, 'pending')}
              label="投递中"
              value={formatPercent(rates.pending)}
              hint={`(投递中 ${formatNumber(totals.pending)})`}
            />
            <MetricCard
              to={recipientLink(id, 'opened')}
              label="不重复打开率"
              value={formatPercent(rates.uniqueOpen)}
              hint={`(打开人数 ${formatNumber(totals.uniqueOpens)})`}
            />
            <MetricCard
              to={recipientLink(id, 'clicked')}
              label="不重复点击率"
              value={formatPercent(rates.uniqueClick)}
              hint={`(点击人数 ${formatNumber(totals.uniqueClicks)})`}
            />
          </div>

          {/* Row 2 — commerce metrics. All four drill to the same `sales`
              tab; the orders/attribution pipeline isn't wired yet so the
              destination shows an "即将推出" placeholder. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <MetricCard to={recipientLink(id, 'sales')} label="销售额" value="US$0" />
            <MetricCard to={recipientLink(id, 'sales')} label="订单数" value="0" />
            <MetricCard
              to={recipientLink(id, 'sales')}
              label="转化率"
              value="0%"
              hint="(下单人数 0)"
            />
          </div>

          {/* Row 3 — secondary deliverability strip. Each label is a link to
              the matching tab. 无效邮箱率 = hard bounces only (permanent
              failures); 弹回邮箱率 = all bounces (hard + soft). */}
          <div className="rounded-lg bg-muted/40 px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm sm:gap-x-10">
              <SmallStat
                to={recipientLink(id, 'invalid')}
                label="无效邮箱率"
                value={formatPercent(rates.bounceHard)}
                hint={`(无效邮箱 ${formatNumber(totals.bouncesHard)})`}
              />
              <SmallStat
                to={recipientLink(id, 'failed')}
                label="发送失败率"
                value={formatPercent(failureRate)}
                hint={`(发送失败 ${formatNumber(totals.failed)})`}
              />
              <SmallStat
                to={recipientLink(id, 'bounced')}
                label="弹回邮箱率"
                value={formatPercent(rates.bounce)}
                hint={`(弹回邮箱 ${formatNumber(totals.bounces)})`}
              />
              <SmallStat
                to={recipientLink(id, 'unsubscribed')}
                label="退订率"
                value={formatPercent(rates.unsubscribe)}
                hint={`(退订数 ${formatNumber(totals.unsubscribes)})`}
              />
              <SmallStat
                to={recipientLink(id, 'complained')}
                label="投诉率"
                value={formatPercent(rates.complaint)}
                hint={`(投诉数 ${formatNumber(totals.complaints)})`}
              />
            </div>
          </div>

          {/* UTM tracking — only rendered when the campaign appended UTM params */}
          {utmRows.length > 0 && (
            <div className="px-1 pt-2">
              <div className="text-sm font-semibold">UTM数据追踪</div>
              <div className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                {utmRows.map((r) => (
                  <div key={r.key}>
                    <span>{r.key}: </span>
                    <span className="text-foreground">{r.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="mb-4 text-sm font-medium">用户转化漏斗</div>
          <HorizontalFunnel funnel={funnel} />
        </CardContent>
      </Card>
    </div>
  );
}

function collectUtm(d: CampaignDetail): Array<{ key: string; value: string }> {
  if (!d.utmEnabled) return [];
  const rows: Array<{ key: string; value: string }> = [];
  if (d.utmSource) rows.push({ key: 'utm_source', value: d.utmSource });
  if (d.utmMedium) rows.push({ key: 'utm_medium', value: d.utmMedium });
  if (d.utmCampaign) rows.push({ key: 'utm_campaign', value: d.utmCampaign });
  return rows;
}

/** Build the recipients-page URL for a given dimension tab. */
function recipientLink(id: string | undefined, tab: string): string {
  return `/campaigns/${id}/recipients?tab=${tab}`;
}

/**
 * Headline metric card — the big rounded grey tiles in rows 1 and 2.
 * Renders as a Link so the entire tile is clickable; the trailing chevron
 * darkens on hover to make affordance explicit.
 */
function MetricCard({
  label,
  value,
  hint,
  to,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group relative block rounded-xl border bg-muted/40 px-5 py-4 transition hover:border-primary/40 hover:bg-muted/60"
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <ChevronRight
        className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50 transition-colors group-hover:text-primary"
        aria-hidden="true"
      />
    </Link>
  );
}

/**
 * Compact inline stat used in row 3. Layout: `label  value  (hint)`, all on
 * one line, designed to be packed alongside siblings via flex-wrap. Wrapped
 * in a Link so the whole stat is clickable.
 */
function SmallStat({
  label,
  value,
  hint,
  to,
}: {
  label: string;
  value: string;
  hint: string;
  /** Omit for stats with no recipients drill-down (e.g. 投递中). */
  to?: string;
}) {
  const content = (
    <>
      <span className={to ? 'text-muted-foreground hover:text-primary' : 'text-muted-foreground'}>
        {label}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </>
  );
  if (!to) {
    return <div className="flex items-baseline gap-2">{content}</div>;
  }
  return (
    <Link
      to={to}
      className="flex items-baseline gap-2 rounded transition-colors hover:text-primary"
    >
      {content}
    </Link>
  );
}

type FunnelStep = { step: string; value: number; pct: number };

function HorizontalFunnel({ funnel }: { funnel: FunnelStep[] }) {
  const byStep = new Map(funnel.map((f) => [f.step, f]));
  const steps: FunnelStep[] = FUNNEL_ORDER.map(
    (step) => byStep.get(step) ?? { step, value: 0, pct: 0 },
  );

  return (
    // Funnel keeps 5 columns at every breakpoint — splitting them visually
    // breaks the "connected slope" semantic that the SVG depends on.
    // Instead we shrink the text + tighten gaps below sm so a 360px screen
    // shows all 5 cells without horizontal scroll.
    <div className="grid grid-cols-5 gap-1 sm:gap-2">
      {steps.map((step, i) => (
        <FunnelCell key={step.step} step={step} next={steps[i + 1]} />
      ))}
    </div>
  );
}

function FunnelCell({ step, next }: { step: FunnelStep; next?: FunnelStep }) {
  const label = FUNNEL_LABEL[step.step] ?? step.step;
  const countLabel = FUNNEL_COUNT_LABEL[step.step] ?? '数量';
  const minH = 0.015;
  const h = Math.max(step.pct, minH);
  const nextH = Math.max(next?.pct ?? 0, minH);
  const top = (1 - h) * 100;
  const nextTop = (1 - nextH) * 100;

  return (
    <div className="min-w-0 text-primary">
      <div className="px-1">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        {/* Stack value over count below sm — 5 cells at 60px wide can't
            host "98.7% (送达数 12,345)" on one line. */}
        <div className="mt-1 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <div className="text-base font-semibold tabular-nums text-foreground sm:text-2xl">
            {formatPercent(step.pct, 2)}
          </div>
          <div className="truncate text-[11px] text-muted-foreground sm:text-xs">
            {countLabel} {formatNumber(step.value)}
          </div>
        </div>
      </div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="mt-3 block h-32 w-full"
      >
        <rect x="0" y={top} width="50" height={100 - top} fill="currentColor" />
        <polygon
          points={`50,${top} 100,${nextTop} 100,100 50,100`}
          fill="currentColor"
          opacity="0.18"
        />
      </svg>
    </div>
  );
}
