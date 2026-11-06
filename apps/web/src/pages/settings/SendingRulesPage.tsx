import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { Loader2, Plus, ShieldBan, ShieldCheck, Trash2 } from 'lucide-react';
import type { SendingRuleMode, SendingRuleView } from '@sendmast/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableSkeletonRows } from '@/components/ui/skeleton';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

type CreateSendingRuleInput = {
  mode: SendingRuleMode;
  senderDomainPattern: string;
  recipientPattern: string;
};

function sameRule(rule: SendingRuleView, input: CreateSendingRuleInput) {
  return (
    rule.mode === input.mode &&
    rule.senderDomainPattern.toLowerCase() === input.senderDomainPattern.toLowerCase() &&
    rule.recipientPattern.toLowerCase() === input.recipientPattern.toLowerCase()
  );
}

export function SendingRulesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [mode, setMode] = useState<SendingRuleMode>('block');
  const [senderDomainPattern, setSenderDomainPattern] = useState('');
  const [recipientPattern, setRecipientPattern] = useState('');

  const rules = useQuery<SendingRuleView[]>({
    queryKey: ['sending-rules'],
    queryFn: async () => (await api.get('/api/sending-rules')).data,
  });

  const completeCreate = (nextRules?: SendingRuleView[]) => {
    if (nextRules) qc.setQueryData(['sending-rules'], nextRules);
    else qc.invalidateQueries({ queryKey: ['sending-rules'] });
    setSenderDomainPattern('');
    setRecipientPattern('');
    toast('发送规则已添加', 'success');
  };

  const createMut = useMutation({
    mutationFn: (input: CreateSendingRuleInput) => api.post('/api/sending-rules', input),
    onSuccess: () => {
      completeCreate();
    },
    onError: async (error, input) => {
      if (axios.isAxiosError(error) && !error.response) {
        try {
          const nextRules = (await api.get<SendingRuleView[]>('/api/sending-rules')).data;
          if (nextRules.some((rule) => sameRule(rule, input))) {
            completeCreate(nextRules);
            return;
          }
        } catch {
          // Keep the original network error when the reconciliation request also fails.
        }
      }
      toast(apiErrMessage(error), 'error');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/sending-rules/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sending-rules'] });
      toast('发送规则已删除', 'success');
    },
    onError: (error) => toast(apiErrMessage(error), 'error'),
  });

  const canCreate = senderDomainPattern.trim() !== '' && recipientPattern.trim() !== '';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">发送规则</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          按发件域名限制允许或禁止发送的收件邮箱类型。
        </p>
      </div>

      <Card>
        <CardContent className="p-5">
          <form
            className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_180px_minmax(0,1fr)_auto] xl:items-start"
            onSubmit={(event) => {
              event.preventDefault();
              if (canCreate) {
                createMut.mutate({
                  mode,
                  senderDomainPattern: senderDomainPattern.trim(),
                  recipientPattern: recipientPattern.trim(),
                });
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="sender-domain-pattern">发件域名规则</Label>
              <Input
                id="sender-domain-pattern"
                value={senderDomainPattern}
                onChange={(event) => setSenderDomainPattern(event.target.value)}
                placeholder="例如 *.example.com"
                className="font-mono"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">支持 example.com、*.example.com 或 *</p>
            </div>
            <div className="space-y-2">
              <Label>规则类型</Label>
              <div className="grid h-9 grid-cols-2 gap-1 rounded-md border bg-muted p-1">
                {(['allow', 'block'] as const).map((value) => {
                  const selected = mode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setMode(value)}
                      className={cn(
                        'flex items-center justify-center gap-1 rounded-sm px-2 text-sm font-medium transition-colors',
                        selected &&
                          value === 'allow' &&
                          'bg-emerald-600 text-white shadow-sm hover:bg-emerald-600',
                        selected &&
                          value === 'block' &&
                          'bg-red-600 text-white shadow-sm hover:bg-red-600',
                        !selected &&
                          'bg-background text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground',
                      )}
                    >
                      {value === 'allow' ? (
                        <ShieldCheck className="size-3.5" />
                      ) : (
                        <ShieldBan className="size-3.5" />
                      )}
                      {value === 'allow' ? '允许' : '禁止'}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">允许优先于禁止</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="recipient-pattern">收件邮箱规则</Label>
              <Input
                id="recipient-pattern"
                value={recipientPattern}
                onChange={(event) => setRecipientPattern(event.target.value)}
                placeholder="例如 *.edu 或 *@gmail.com"
                className="font-mono"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                支持邮箱域名、域名后缀或完整地址通配符
              </p>
            </div>
            <Button
              type="submit"
              className="xl:mt-7"
              disabled={!canCreate || createMut.isPending}
            >
              {createMut.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Plus className="mr-1 size-4" />
              )}
              添加规则
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-5 py-4 font-medium">规则列表</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3 text-left font-medium">类型</th>
                <th className="px-5 py-3 text-left font-medium">发件域名规则</th>
                <th className="px-5 py-3 text-left font-medium">收件邮箱规则</th>
                <th className="px-5 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.isLoading && <TableSkeletonRows columns={4} cellClassName="px-5 py-4" />}
              {!rules.isLoading && (rules.data?.length ?? 0) === 0 && (
                <EmptyStateRow colSpan={4} title="暂无发送规则" />
              )}
              {rules.data?.map((rule) => (
                <tr key={rule.id} className="border-b last:border-b-0">
                  <td className="px-5 py-4">
                    <Badge variant={rule.mode === 'allow' ? 'success' : 'danger'}>
                      {rule.mode === 'allow' ? (
                        <ShieldCheck className="mr-1 size-3" />
                      ) : (
                        <ShieldBan className="mr-1 size-3" />
                      )}
                      {rule.mode === 'allow' ? '允许' : '禁止'}
                    </Badge>
                  </td>
                  <td className="px-5 py-4">
                    <code className="font-mono text-sm">{rule.senderDomainPattern}</code>
                  </td>
                  <td className="px-5 py-4">
                    <code className="font-mono text-sm">{rule.recipientPattern}</code>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button
                      type="button"
                      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                      title="删除规则"
                      disabled={deleteMut.isPending}
                      onClick={async () => {
                        const label = rule.mode === 'allow' ? '允许' : '禁止';
                        const ok = await confirm({
                          title: '删除发送规则？',
                          description: `${rule.senderDomainPattern} 的“${label} ${rule.recipientPattern}”规则将立即失效。`,
                          variant: 'danger',
                          confirmLabel: '删除',
                        });
                        if (ok) deleteMut.mutate(rule.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
