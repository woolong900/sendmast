import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  Send,
  ShoppingCart,
  MailOpen,
  Plus,
  Wallet,
  CircleDollarSign,
  ReceiptText,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/utils';
import { useAuth } from '@/store/auth';
import { useQuota } from '@/hooks/useQuota';

interface DashboardSummary {
  contacts: { total: number; subscribed: number };
  campaigns: { draft: number; scheduled: number; sending: number; sent: number };
  metrics30d: { sent: number; uniqueOpens: number; openRate: number };
  shopConnected: boolean;
  sales: { revenue: number; orders: number; aov: number };
}

export function DashboardPage() {
  const { user, account } = useAuth();
  const accountStatus = account?.status;
  const canCreate = !accountStatus || accountStatus === 'active';
  const disabledHint =
    accountStatus === 'pending_activation'
      ? '请先激活账号(点击注册邮箱里的激活链接)后再创建活动。'
      : accountStatus === 'suspended'
        ? '账号已被封禁,无法创建活动。'
        : '';

  const { data, isLoading } = useQuery<DashboardSummary>({
    queryKey: ['dashboard'],
    queryFn: async () => (await api.get('/api/dashboard/summary')).data,
  });
  const { data: quota } = useQuota();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold sm:text-2xl">
            欢迎，{user?.displayName ?? '朋友'} 👋
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{account?.name} 的运营概览</p>
        </div>
        {canCreate ? (
          <Button asChild className="w-full sm:w-auto">
            <Link to="/campaigns/new">
              <Plus className="mr-1 size-4" />
              新建营销活动
            </Link>
          </Button>
        ) : (
          <Button disabled title={disabledHint} className="w-full sm:w-auto">
            <Plus className="mr-1 size-4" />
            新建营销活动
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<Wallet className="size-5" />}
          label="剩余发送额度"
          value={quota ? formatNumber(quota.remaining) : <Skeleton className="h-7 w-24" />}
          tone={
            quota?.remaining === 0
              ? 'destructive'
              : (quota?.remaining ?? 0) < 1000
                ? 'amber'
                : 'primary'
          }
          link="/settings/quota"
        />
        <StatCard
          icon={<Users className="size-5" />}
          label="联系人总数"
          value={
            isLoading ? <Skeleton className="h-7 w-20" /> : formatNumber(data?.contacts.total ?? 0)
          }
          tone="emerald"
          link="/contacts"
        />
        <StatCard
          icon={<Send className="size-5" />}
          label="近 30 日发送量"
          value={
            isLoading ? <Skeleton className="h-7 w-20" /> : formatNumber(data?.metrics30d.sent ?? 0)
          }
          tone="blue"
          link="/campaigns"
        />
        <StatCard
          icon={<MailOpen className="size-5" />}
          label="近 30 日打开率"
          value={
            isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              `${((data?.metrics30d.openRate ?? 0) * 100).toFixed(1)}%`
            )
          }
          tone="amber"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">活动状态</h2>
              <Button asChild variant="ghost" size="sm">
                <Link to="/campaigns">查看全部</Link>
              </Button>
            </div>
            {isLoading ? (
              <div className="grid grid-cols-2 gap-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <StatusItem label="草稿" value={data?.campaigns.draft ?? 0} variant="muted" />
                <StatusItem label="已定时" value={data?.campaigns.scheduled ?? 0} variant="warning" />
                <StatusItem label="发送中" value={data?.campaigns.sending ?? 0} variant="default" />
                <StatusItem label="已完成" value={data?.campaigns.sent ?? 0} variant="success" />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">销售概览</h2>
              <Button asChild variant="ghost" size="sm">
                <Link to="/settings/shop">店铺设置</Link>
              </Button>
            </div>
            {isLoading ? (
              <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : data?.shopConnected ? (
              <div className="grid grid-cols-3 gap-4">
                <SalesStat
                  icon={<CircleDollarSign className="size-4" />}
                  label="近 30 日营收"
                  value={formatUsd(data.sales.revenue)}
                  tone="emerald"
                />
                <SalesStat
                  icon={<ReceiptText className="size-4" />}
                  label="订单数"
                  value={formatNumber(data.sales.orders)}
                  tone="blue"
                />
                <SalesStat
                  icon={<TrendingUp className="size-4" />}
                  label="客单价"
                  value={formatUsd(data.sales.aov)}
                  tone="amber"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <ShoppingCart className="mb-2 size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  尚未关联店铺。连接 Shopyy 店铺后，即可看到邮件带来的销售额。
                </p>
                <Button asChild variant="outline" size="sm" className="mt-4">
                  <Link to="/settings/shop">关联店铺</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const TONE_BG: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  emerald: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700',
  blue: 'bg-blue-100 text-blue-700',
  destructive: 'bg-destructive/10 text-destructive',
};

function StatCard({
  icon,
  label,
  value,
  tone,
  link,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone: keyof typeof TONE_BG;
  link?: string;
}) {
  const inner = (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-2xl font-semibold">{value}</div>
        </div>
        <div className={`flex size-10 items-center justify-center rounded-lg ${TONE_BG[tone]}`}>
          {icon}
        </div>
      </CardContent>
    </Card>
  );
  return link ? <Link to={link}>{inner}</Link> : inner;
}

function formatUsd(amount: number): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `US$${amount.toFixed(2)}`;
  }
}

const SALES_TONE: Record<string, { box: string; icon: string; value: string }> = {
  emerald: {
    box: 'border-emerald-200 bg-emerald-50/70',
    icon: 'bg-emerald-100 text-emerald-700',
    value: 'text-emerald-700',
  },
  blue: {
    box: 'border-blue-200 bg-blue-50/70',
    icon: 'bg-blue-100 text-blue-700',
    value: 'text-blue-700',
  },
  amber: {
    box: 'border-amber-200 bg-amber-50/70',
    icon: 'bg-amber-100 text-amber-700',
    value: 'text-amber-700',
  },
};

function SalesStat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: keyof typeof SALES_TONE;
}) {
  const colors = SALES_TONE[tone];
  return (
    <div className={`rounded-md border p-3 ${colors.box}`}>
      <div className="flex items-center gap-2">
        <span className={`flex size-7 items-center justify-center rounded-md ${colors.icon}`}>
          {icon}
        </span>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
      <div className={`mt-2 text-lg font-semibold ${colors.value}`}>{value}</div>
    </div>
  );
}

function StatusItem({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: 'success' | 'warning' | 'default' | 'muted';
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Badge variant={variant}>{formatNumber(value)}</Badge>
      </div>
    </div>
  );
}
