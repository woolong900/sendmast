import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Plus, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UpgradeQuotaModal } from '@/components/UpgradeQuotaModal';
import { formatNumber } from '@/lib/utils';
import { useAuth } from '@/store/auth';
import { useQuota } from '@/hooks/useQuota';

export function QuotaPage() {
  const { account } = useAuth();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const { data, isLoading } = useQuota();

  const remaining = data?.remaining ?? 0;
  const tone =
    remaining === 0 ? 'text-destructive' : remaining < 1000 ? 'text-amber-600' : 'text-foreground';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">发送额度</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {account?.name} 的剩余发送额度。每次邮件发送(成功或失败)消耗 1 个额度;额度归零后活动会立即停止发送。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" asChild className="w-full sm:w-auto">
            <Link to="/settings/orders">
              <Receipt className="mr-1 size-4" />
              我的订单
            </Link>
          </Button>
          <Button onClick={() => setUpgradeOpen(true)} className="w-full sm:w-auto">
            <Plus className="mr-1 size-4" />
            购买额度
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex items-center gap-4 p-6">
          <div className="flex size-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Wallet className="size-6" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">当前剩余</div>
            <div className={`mt-1 text-3xl font-semibold tabular-nums ${tone}`}>
              {isLoading ? <Skeleton className="h-9 w-32" /> : formatNumber(remaining)}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">额度说明</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>支持自助购买:点「购买额度」选择档位,使用支付宝或微信扫码付款后额度立即到账。</li>
            <li>每次发送邮件(无论成功失败)都会消耗 1 个额度。</li>
            <li>额度归零时,正在发送的活动会把剩余收件人标记为失败并结束。</li>
            <li>额度永久有效,不会过期。额度数字每 30 秒自动刷新一次。</li>
          </ul>
        </CardContent>
      </Card>

      <UpgradeQuotaModal
        open={upgradeOpen}
        currentRemaining={remaining}
        onClose={() => setUpgradeOpen(false)}
      />
    </div>
  );
}
