import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { init as initAirwallex } from '@airwallex/components-sdk';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { cn, formatNumber } from '@/lib/utils';
import type {
  CreateQuotaOrderResponse,
  FxRateView,
  PaymentChannel,
  QuotaOrderView,
  QuotaPricingTierView,
} from '@sendmast/shared';

interface Props {
  open: boolean;
  /** Optional — shown above the tier grid as "您当前剩余 X 邮件". */
  currentRemaining?: number;
  onClose: () => void;
}

/**
 * The API chooses the configured payment provider. Shouqianba orders display
 * a QR code here; Airwallex orders redirect to its hosted checkout.
 */
export function UpgradeQuotaModal({ open, currentRemaining, onClose }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [channel, setChannel] = useState<PaymentChannel>('alipay');
  const [order, setOrder] = useState<CreateQuotaOrderResponse | null>(null);
  const qrOrder = order?.provider === 'shouqianba' ? order : null;

  const { data: tiers, isLoading } = useQuery<QuotaPricingTierView[]>({
    queryKey: ['quota-tiers'],
    queryFn: async () => (await api.get('/api/quota-tiers')).data,
    enabled: open,
  });

  // FX is needed because the gateway only settles in CNY — the actual ¥
  // amount charged at checkout is what the user really wants to know
  // before committing. Show it next to the USD price.
  const { data: fx } = useQuery<FxRateView>({
    queryKey: ['fx', 'usd-cny'],
    queryFn: async () => (await api.get('/api/fx/usd-cny')).data,
    enabled: open,
  });

  // Auto-select the first tier when data arrives so the price footer isn't
  // empty on open.
  useEffect(() => {
    if (open && tiers && tiers.length > 0 && !selected) {
      setSelected(tiers[0].id);
    }
  }, [open, tiers, selected]);

  // Reset everything when modal closes so reopening starts fresh.
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setChannel('alipay');
      setOrder(null);
    }
  }, [open]);

  // ESC closes; mirrors confirm-dialog UX.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const orderMut = useMutation<
    CreateQuotaOrderResponse,
    unknown,
    { tierId: string; channel: PaymentChannel }
  >({
    mutationFn: async (vars) => {
      const order = (await api.post('/api/quota-orders', vars)).data as CreateQuotaOrderResponse;
      if (order.provider === 'shouqianba') return order;

      const { payments } = await initAirwallex({
        env: order.environment,
        locale: 'zh',
        enabledElements: ['payments'],
      });
      if (!payments) throw new Error('空中云汇收银台加载失败');
      const error = payments.redirectToCheckout({
        env: order.environment,
        mode: 'payment',
        intent_id: order.orderId,
        client_secret: order.clientSecret,
        currency: order.currency,
        country_code: 'CN',
        locale: 'zh',
        successUrl: order.successUrl,
        appearance: {
          mode: 'light',
          variables: { colorBrand: '#2563eb' },
        },
      });
      if (typeof error === 'string' && error) throw new Error(error);
      return order;
    },
    onSuccess: (created) => {
      if (created.provider === 'shouqianba') setOrder(created);
    },
    onError: (err) => toast(`下单失败:${apiErrMessage(err)}`, 'error'),
  });

  const { data: orderStatus } = useQuery<QuotaOrderView>({
    queryKey: ['quota-order', qrOrder?.orderId],
    queryFn: async () => (await api.get(`/api/quota-orders/${qrOrder!.orderId}`)).data,
    enabled: Boolean(qrOrder),
    refetchInterval: (query) =>
      ['paid', 'failed', 'cancelled'].includes(query.state.data?.status ?? '') ? false : 2000,
  });
  const paid = orderStatus?.status === 'paid';

  useEffect(() => {
    if (!paid) return;
    void qc.invalidateQueries({ queryKey: ['me', 'quota'] });
    void qc.invalidateQueries({ queryKey: ['quota-orders'] });
    const timer = window.setTimeout(onClose, 1500);
    return () => window.clearTimeout(timer);
  }, [paid, qc, onClose]);

  const selectedTier = useMemo(
    () => tiers?.find((t) => t.id === selected) ?? null,
    [tiers, selected],
  );
  const selectedCny = selectedTier && fx ? selectedTier.priceUsd * fx.rate : null;
  const fxFetchedDate = fx ? new Date(fx.fetchedAt).toLocaleDateString('zh-CN') : null;

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (qrOrder && !paid) return;
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        // max-h + overflow-y-auto so the modal scrolls inside its own
        // viewport on phones — tier grid + purchase notes + footer can
        // exceed 667px (iPhone SE) once everything is stacked.
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-y-auto rounded-xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{qrOrder ? '扫码支付' : '升级套餐'}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {qrOrder ? (
                paid ? (
                  '支付成功,额度已到账'
                ) : (
                  `请使用${qrOrder.channel === 'wechat' ? '微信' : '支付宝'}扫描二维码付款`
                )
              ) : currentRemaining !== undefined ? (
                <>
                  您当前剩余{' '}
                  <span className="font-semibold tabular-nums text-foreground">
                    {formatNumber(currentRemaining)}
                  </span>{' '}
                  邮件,请选择需要增加的额度:
                </>
              ) : (
                '请选择需要增加的额度:'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="size-5" />
          </button>
        </div>

        {qrOrder ? (
          <QrStep order={qrOrder} paid={paid} onClose={onClose} />
        ) : (
          <SelectStep
            tiers={tiers}
            isLoading={isLoading}
            selected={selected}
            onSelect={setSelected}
            channel={channel}
            onChannelChange={setChannel}
            selectedTier={selectedTier}
            selectedCny={selectedCny}
            fx={fx}
            fxFetchedDate={fxFetchedDate}
            submitting={orderMut.isPending}
            onSubmit={() => selected && orderMut.mutate({ tierId: selected, channel })}
            onCancel={onClose}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Step 1 — pick a tier
// ---------------------------------------------------------------------------

function SelectStep({
  tiers,
  isLoading,
  selected,
  onSelect,
  channel,
  onChannelChange,
  selectedTier,
  selectedCny,
  fx,
  fxFetchedDate,
  submitting,
  onSubmit,
  onCancel,
}: {
  tiers: QuotaPricingTierView[] | undefined;
  isLoading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  channel: PaymentChannel;
  onChannelChange: (channel: PaymentChannel) => void;
  selectedTier: QuotaPricingTierView | null;
  selectedCny: number | null;
  fx: FxRateView | undefined;
  fxFetchedDate: string | null;
  submitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="grid gap-6 p-6 md:grid-cols-[1fr_280px]">
        <div>
          {isLoading ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中…
            </div>
          ) : !tiers || tiers.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              暂无可购买档位
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {tiers.map((t) => {
                const isSelected = t.id === selected;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onSelect(t.id)}
                    className={cn(
                      'rounded-lg border-2 px-4 py-4 text-left transition-all',
                      isSelected
                        ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                        : 'border-border hover:border-muted-foreground/30',
                    )}
                  >
                    <div className="text-sm font-medium text-foreground">
                      +{formatNumber(t.emails)}封
                    </div>
                    <div className="mt-2">
                      <span className="text-xs text-muted-foreground">US</span>
                      <span className="ml-0.5 text-2xl font-bold tabular-nums">${t.priceUsd}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      单价: US${t.unitPriceUsd}/封
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <aside className="rounded-lg bg-muted/30 p-4">
          <div className="mb-3 text-sm font-semibold">购买说明</div>
          <ol className="list-decimal space-y-2 pl-4 text-xs leading-relaxed text-muted-foreground">
            <li>选择档位和支付方式后,生成对应的付款二维码。</li>
            <li>支付成功后,所购买的发送额度将立即添加到您的账户。</li>
            <li>额度永久有效,不会过期 —— 用多少扣多少。</li>
            <li>如有支付问题或想要批量采购,请联系平台管理员。</li>
          </ol>

          <div className="mt-4 border-t pt-3">
            <div className="mb-2 text-xs font-semibold text-muted-foreground">支付方式</div>
            <div className="inline-flex rounded-md border bg-background p-1">
              {(['alipay', 'wechat'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={submitting}
                  onClick={() => onChannelChange(value)}
                  className={cn(
                    'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                    channel === value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {value === 'alipay' ? '支付宝' : '微信'}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <div className="flex items-center justify-between gap-4 border-t bg-muted/20 px-6 py-4">
        <div className="min-w-0 text-sm text-muted-foreground">
          {selectedTier ? (
            <div className="space-y-1">
              <div>
                价格:{' '}
                <span className="text-base font-semibold text-foreground">
                  US${selectedTier.priceUsd}
                </span>
                {selectedCny !== null && (
                  <span className="ml-2 text-xs">
                    ≈{' '}
                    <span className="font-medium text-foreground/80 tabular-nums">
                      ¥{selectedCny.toFixed(2)}
                    </span>{' '}
                    (实际付款金额)
                  </span>
                )}
              </div>
              {fx && (
                <div className="text-[11px] text-muted-foreground">
                  汇率: 1 USD ≈ ¥{fx.rate.toFixed(4)}{' '}
                  <span className="opacity-60">
                    · {fx.source === 'manual' ? '管理员' : 'Frankfurter'} · {fxFetchedDate}
                  </span>
                </div>
              )}
            </div>
          ) : (
            '请先选择档位'
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={!selected || submitting || !fx}>
            {submitting ? (
              <>
                <Loader2 className="mr-1 size-4 animate-spin" />
                生成二维码中
              </>
            ) : (
              '立即支付'
            )}
          </Button>
        </div>
      </div>
    </>
  );
}

function QrStep({
  order,
  paid,
  onClose,
}: {
  order: Extract<CreateQuotaOrderResponse, { provider: 'shouqianba' }>;
  paid: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 p-8">
      <div className="relative rounded-lg border bg-white p-4">
        <QRCodeSVG value={order.qrCode} size={220} level="M" />
        {paid && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/95">
            <CheckCircle2 className="size-20 text-emerald-500" strokeWidth={1.5} />
          </div>
        )}
      </div>
      <div className="text-center">
        <div className="text-2xl font-semibold tabular-nums">¥{order.amountCny.toFixed(2)}</div>
        <div className="mt-1 text-xs text-muted-foreground">≈ US${order.amountUsd.toFixed(2)}</div>
      </div>
      <div className="text-sm font-medium">
        {paid ? (
          <span className="text-emerald-600">支付成功,额度已到账</span>
        ) : (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            等待扫码支付…
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">订单号: {order.orderId}</div>
      <Button variant="outline" size="sm" onClick={onClose}>
        {paid ? '关闭' : '取消'}
      </Button>
    </div>
  );
}
