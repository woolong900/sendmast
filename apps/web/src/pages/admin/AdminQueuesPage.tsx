import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import type { QueueOverview } from '@sendmast/shared';

const COUNT_KEYS: Array<keyof QueueOverview['counts']> = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'paused',
  'completed',
];

const COUNT_LABELS: Record<keyof QueueOverview['counts'], string> = {
  waiting: '等待',
  active: '执行中',
  delayed: '延迟',
  failed: '失败',
  paused: '暂停',
  completed: '完成',
};

export function AdminQueuesPage() {
  const query = useQuery<QueueOverview[]>({
    queryKey: ['admin', 'queues'],
    queryFn: async () => (await api.get('/api/admin/queues')).data,
    refetchInterval: 10_000,
  });

  const queues = query.data ?? [];
  const totals = queues.reduce(
    (acc, q) => {
      acc.waiting += q.counts.waiting;
      acc.active += q.counts.active;
      acc.failed += q.counts.failed;
      return acc;
    },
    { waiting: 0, active: 0, failed: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">队列监控</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            查看 BullMQ 队列长度、执行中任务、失败任务、重试次数和最近错误。
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          className="w-full sm:w-auto"
        >
          <RefreshCw className={`mr-1 size-4 ${query.isFetching ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="等待任务" value={totals.waiting} tone="default" />
        <Stat label="执行中" value={totals.active} tone="success" />
        <Stat label="失败任务" value={totals.failed} tone={totals.failed > 0 ? 'danger' : 'muted'} />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">队列</th>
                  {COUNT_KEYS.map((key) => (
                    <th key={key} className="px-4 py-3 font-medium">
                      {COUNT_LABELS[key]}
                    </th>
                  ))}
                  <th className="px-4 py-3 font-medium">最近错误</th>
                </tr>
              </thead>
              <tbody>
                {query.isLoading && <TableSkeletonRows columns={8} />}
                {!query.isLoading && queues.length === 0 && (
                  <EmptyStateRow colSpan={8} title="暂无队列数据" />
                )}
                {queues.map((q) => {
                  const latestFailed = q.failedJobs[0];
                  return (
                    <tr key={q.name} className="border-b last:border-0 align-top">
                      <td className="px-4 py-3 font-mono text-xs">{q.name}</td>
                      {COUNT_KEYS.map((key) => (
                        <td key={key} className="px-4 py-3">
                          <Badge variant={countVariant(key, q.counts[key])}>
                            {formatNumber(q.counts[key])}
                          </Badge>
                        </td>
                      ))}
                      <td className="px-4 py-3">
                        {latestFailed ? (
                          <div className="max-w-md space-y-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-mono">{latestFailed.name}</span>
                              <Badge variant="danger">
                                {latestFailed.attemptsMade}/
                                {latestFailed.attemptsLimit ?? '-'}
                              </Badge>
                              {latestFailed.finishedOn && (
                                <span className="text-muted-foreground">
                                  {formatDateTime(latestFailed.finishedOn)}
                                </span>
                              )}
                            </div>
                            <div
                              className="line-clamp-2 text-xs text-rose-700"
                              title={latestFailed.failedReason ?? ''}
                            >
                              {latestFailed.failedReason ?? '无错误详情'}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {queues.some((q) => q.failedJobs.length > 0) && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <h2 className="text-base font-semibold">失败任务明细</h2>
            <div className="space-y-3">
              {queues.flatMap((q) =>
                q.failedJobs.map((job) => (
                  <div key={`${q.name}-${job.id}`} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono">{q.name}</span>
                      <span className="font-mono">{job.name}</span>
                      <Badge variant="danger">
                        重试 {job.attemptsMade}/{job.attemptsLimit ?? '-'}
                      </Badge>
                      {job.finishedOn && (
                        <span className="text-muted-foreground">
                          {formatDateTime(job.finishedOn)}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-xs text-rose-700">
                      {job.failedReason ?? '无错误详情'}
                    </p>
                  </div>
                )),
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'default' | 'success' | 'danger' | 'muted';
}) {
  return (
    <Card className="rounded-lg">
      <CardContent className="flex items-center justify-between p-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Badge variant={tone}>{formatNumber(value)}</Badge>
      </CardContent>
    </Card>
  );
}

function countVariant(
  key: keyof QueueOverview['counts'],
  value: number,
): 'default' | 'success' | 'warning' | 'danger' | 'muted' {
  if (key === 'failed' && value > 0) return 'danger';
  if (key === 'active' && value > 0) return 'success';
  if ((key === 'waiting' || key === 'delayed') && value > 0) return 'warning';
  return 'muted';
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(n);
}
