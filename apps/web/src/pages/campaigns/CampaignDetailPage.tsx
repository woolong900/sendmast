import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, Pause, Play, Send, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/utils';

interface CampaignDetail {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  status: string;
  totalRecipients: number;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  html: string | null;
  lists: Array<{ list: { id: string; name: string } }>;
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();

  const { data, isLoading } = useQuery<CampaignDetail>({
    queryKey: ['campaigns', id],
    queryFn: async () => (await api.get(`/api/campaigns/${id}`)).data,
    enabled: !!id,
  });

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['campaigns', id] }),
      qc.invalidateQueries({ queryKey: ['campaigns'] }),
    ]);

  const sendMut = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${id}/send`),
    onError: (err) => toast(`发送失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });
  const pauseMut = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${id}/pause`),
    onError: (err) => toast(`暂停失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });
  const resumeMut = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${id}/resume`),
    onError: (err) => toast(`继续失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });
  const cancelMut = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${id}/cancel`),
    onError: (err) => toast(`取消失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/api/campaigns/${id}`),
    onError: (err) => toast(`删除失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: () => navigate('/campaigns'),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">加载中...</div>;
  if (!data) return null;

  const editable = data.status === 'draft' || data.status === 'scheduled';
  const canViewAnalytics = data.status === 'sending' || data.status === 'sent';
  const canPause = data.status === 'sending' || data.status === 'scheduled';
  const canResume = data.status === 'paused';
  const canCancel =
    data.status === 'sending' || data.status === 'scheduled' || data.status === 'paused';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" asChild className="shrink-0">
          <Link to="/campaigns" aria-label="返回列表">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-xl font-semibold">{data.name}</h1>
        <Badge variant={statusVariant(data.status)} className="shrink-0">
          <span className="mr-1 inline-block size-1.5 rounded-full bg-current opacity-70" />
          {statusLabel(data.status)}
        </Badge>
        <div className="ml-auto flex shrink-0 gap-2">
          {canViewAnalytics && (
            <Button asChild variant="outline">
              <Link to={`/campaigns/${id}/analytics`}>
                <BarChart3 className="mr-1 size-4" />
                查看数据
              </Link>
            </Button>
          )}
          {canPause && (
            <Button
              variant="outline"
              onClick={() => pauseMut.mutate()}
              disabled={pauseMut.isPending}
            >
              <Pause className="mr-1 size-4" />
              {pauseMut.isPending ? '提交中...' : '暂停'}
            </Button>
          )}
          {canResume && (
            <Button onClick={() => resumeMut.mutate()} disabled={resumeMut.isPending}>
              <Play className="mr-1 size-4" />
              {resumeMut.isPending ? '提交中...' : '继续'}
            </Button>
          )}
          {canCancel && (
            <Button
              variant="outline"
              onClick={async () => {
                const ok = await confirm({
                  title: '取消活动',
                  description: (
                    <>
                      确定取消「<span className="font-medium">{data.name}</span>」吗?已发送的邮件无法撤回。
                    </>
                  ),
                  confirmLabel: '取消活动',
                  cancelLabel: '不,继续发送',
                  variant: 'danger',
                });
                if (ok) cancelMut.mutate();
              }}
              disabled={cancelMut.isPending}
              className="text-destructive hover:text-destructive"
            >
              <XCircle className="mr-1 size-4" />
              {cancelMut.isPending ? '取消中...' : '取消'}
            </Button>
          )}
          {editable && (
            <Button onClick={() => sendMut.mutate()} disabled={sendMut.isPending}>
              <Send className="mr-1 size-4" />
              {sendMut.isPending ? '提交中...' : '立即发送'}
            </Button>
          )}
          {editable && (
            <Button
              variant="ghost"
              size="icon"
              disabled={deleteMut.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: '删除活动',
                  description: (
                    <>
                      确定删除活动「<span className="font-medium">{data.name}</span>」吗?该操作不可撤销。
                    </>
                  ),
                  confirmLabel: '删除',
                  variant: 'danger',
                });
                if (ok) deleteMut.mutate();
              }}
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardContent className="p-6">
            <div className="space-y-4 text-sm">
              <Field label="主题" value={data.subject} />
              <Field label="预览文本" value={data.preheader} />
              <Field label="发件人" value={`${data.fromName} <${data.fromEmail}>`} />
              <Field label="回复地址" value={data.replyTo} />
              <Field label="收件人数量" value={formatNumber(data.totalRecipients)} />
              <Field label="收件列表" value={data.lists.map((l) => l.list.name).join(', ')} />
              <Field label="计划发送时间" value={formatDateTime(data.scheduledAt)} />
              <Field label="实际发送时间" value={formatDateTime(data.sentAt)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            <div className="border-b px-6 py-3 text-sm font-medium">邮件预览</div>
            <iframe
              title="email preview"
              srcDoc={data.html ?? '<p style="padding:20px;color:#888">无内容</p>'}
              className="block h-[calc(100vh-220px)] min-h-[600px] w-full"
              sandbox="allow-same-origin"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-semibold text-foreground">{label}</div>
      <div className="mt-1 break-all text-sm text-muted-foreground">{value || '-'}</div>
    </div>
  );
}

function statusLabel(s: string): string {
  return (
    {
      draft: '草稿',
      scheduled: '已定时',
      sending: '发送中',
      sent: '发送成功',
      paused: '已暂停',
      failed: '失败',
      canceled: '已取消',
    }[s] ?? s
  );
}

function statusVariant(s: string): 'success' | 'muted' | 'warning' | 'danger' | 'default' {
  return (
    {
      draft: 'muted',
      scheduled: 'warning',
      sending: 'default',
      sent: 'success',
      paused: 'muted',
      failed: 'danger',
      canceled: 'muted',
    } as const
  )[s as 'draft'] ?? 'default';
}
