import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Truck, ShoppingCart, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import {
  SHOP_AUTOMATION_LABELS,
  type ShopAutomationType,
  type ShopAutomationView,
  type SenderDomainView,
} from '@sendmast/shared';

interface Template {
  id: string;
  name: string;
  scope: 'system' | 'user';
}

const ICONS: Record<ShopAutomationType, typeof Mail> = {
  order_paid: Mail,
  order_shipped: Truck,
  abandoned_cart: ShoppingCart,
};

const DESCRIPTIONS: Record<ShopAutomationType, string> = {
  order_paid: '买家完成支付后立即发送，可用 {{order_no}}、{{order_total}} 等变量。',
  order_shipped: '订单发货后立即发送，可用 {{tracking_url}} 物流追踪链接。',
  abandoned_cart: '买家放弃结账一段时间后发送召回邮件；若期间已下单则自动跳过。',
};

export function ShopAutomationCards({ connectionId }: { connectionId: string }) {
  const automations = useQuery<ShopAutomationView[]>({
    queryKey: ['shop-automations', connectionId],
    queryFn: async () =>
      (await api.get(`/api/integrations/shopyy/${connectionId}/automations`)).data,
  });
  const templates = useQuery<Template[]>({
    queryKey: ['templates'],
    queryFn: async () => (await api.get('/api/templates')).data,
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
    return <p className="text-sm text-muted-foreground">加载自动化配置...</p>;
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-muted-foreground">自动化邮件</div>
      {(automations.data ?? []).map((a) => (
        <AutomationCard
          key={a.id}
          connectionId={connectionId}
          automation={a}
          templates={templates.data ?? []}
          senderOptions={senderOptions}
        />
      ))}
    </div>
  );
}

function AutomationCard({
  connectionId,
  automation,
  templates,
  senderOptions,
}: {
  connectionId: string;
  automation: ShopAutomationView;
  templates: Template[];
  senderOptions: { value: string; label: string; name: string }[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const Icon = ICONS[automation.type];

  const [enabled, setEnabled] = useState(automation.enabled);
  const [templateId, setTemplateId] = useState(automation.templateId ?? '');
  const [fromEmail, setFromEmail] = useState(automation.fromEmail ?? '');
  const [subject, setSubject] = useState(automation.subject ?? '');
  const [delayMinutes, setDelayMinutes] = useState(automation.delayMinutes);

  const save = useMutation({
    mutationFn: async () => {
      const fromName = senderOptions.find((o) => o.value === fromEmail)?.name ?? null;
      const body: Record<string, unknown> = {
        enabled,
        templateId: templateId || null,
        fromEmail: fromEmail || null,
        fromName,
        subject: subject.trim() || null,
      };
      if (automation.type === 'abandoned_cart') body.delayMinutes = delayMinutes;
      return api.patch(
        `/api/integrations/shopyy/${connectionId}/automations/${automation.type}`,
        body,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop-automations', connectionId] });
      toast('已保存自动化配置', 'success');
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-muted text-foreground">
              <Icon className="size-4" />
            </div>
            <div>
              <div className="text-sm font-medium">{SHOP_AUTOMATION_LABELS[automation.type]}</div>
              <div className="text-xs text-muted-foreground">{DESCRIPTIONS[automation.type]}</div>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">邮件模板</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">未选择</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

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

          <label className="space-y-1 text-xs sm:col-span-2">
            <span className="text-muted-foreground">邮件主题</span>
            <input
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={subject}
              placeholder="留空使用默认主题"
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>

          {automation.type === 'abandoned_cart' && (
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">弃单后延迟（分钟）</span>
              <input
                type="number"
                min={5}
                max={10080}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(Number(e.target.value))}
              />
            </label>
          )}
        </div>

        {senderOptions.length === 0 && (
          <p className="text-xs text-amber-600">
            尚无已验证的发件邮箱，请先在「发件域名」中完成验证。
          </p>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="mr-1 size-4" />
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
