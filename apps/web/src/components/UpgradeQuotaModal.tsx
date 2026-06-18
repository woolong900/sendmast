import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
 * Self-service top-up modal — two-step flow:
 *   1. select tier → POST /api/quota-orders
 *   2. show payment QR code → poll GET /api/quota-orders/:id every 2s for `paid`
 *
 * Payment goes through Shouqianba (收钱吧, an aggregator). The QR is a
 * multi-channel jump page — users scan with Alipay or WeChat. Crediting
 * happens server-side via the notify webhook; this modal just polls until
 * status flips. We chose the aggregator over direct Alipay because Alipay
 * 风控 rejected our merchant for online SaaS.
 */
export function UpgradeQuotaModal({ open, currentRemaining, onClose }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [channel, setChannel] = useState<PaymentChannel>('alipay');
  const [order, setOrder] = useState<CreateQuotaOrderResponse | null>(null);

  const step: 'select' | 'qr' = order ? 'qr' : 'select';

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
      setOrder(null);
      setChannel('alipay');
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
    mutationFn: async (vars) => (await api.post('/api/quota-orders', vars)).data,
    onSuccess: (resp) => setOrder(resp),
    onError: (err) => toast(`下单失败:${apiErrMessage(err)}`, 'error'),
  });

  // Poll order status while QR is showing. 2s interval is the sweet spot —
  // fast enough that paying takes a few hundred ms to register on the modal,
  // slow enough that a forgotten-open tab doesn't hammer the API. We stop
  // polling automatically when status flips to a terminal state.
  const { data: orderStatus } = useQuery<QuotaOrderView>({
    queryKey: ['quota-order', order?.orderId],
    queryFn: async () => (await api.get(`/api/quota-orders/${order!.orderId}`)).data,
    enabled: !!order && step === 'qr',
    refetchInterval: (q) =>
      q.state.data?.status === 'paid' || q.state.data?.status === 'failed' ? false : 2000,
  });

  const paid = orderStatus?.status === 'paid';

  // On successful payment: refresh user's remaining quota + order list, then
  // auto-close after a short success display so they see the "已支付" state.
  useEffect(() => {
    if (!paid) return;
    void qc.invalidateQueries({ queryKey: ['me', 'quota'] });
    void qc.invalidateQueries({ queryKey: ['quota-orders'] });
    const t = window.setTimeout(() => {
      onClose();
    }, 1500);
    return () => window.clearTimeout(t);
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
        // Ignore accidental backdrop clicks while a QR is shown and unpaid —
        // the order is still pending server-side; closing here loses the QR.
        if (step === 'qr' && !paid) return;
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        // max-h + overflow-y-auto so the modal scrolls inside its own
        // viewport on phones — tier grid + payment channel + footer can
        // exceed 667px (iPhone SE) once everything is stacked.
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-y-auto rounded-xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">
              {step === 'select' ? '升级套餐' : '扫码支付'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {step === 'select' ? (
                currentRemaining !== undefined ? (
                  <>
                    您当前剩余{' '}
                    <span className="font-semibold tabular-nums text-foreground">
                      {formatNumber(currentRemaining)}
                    </span>{' '}
                    邮件,请选择需要增加的额度:
                  </>
                ) : (
                  '请选择需要增加的额度:'
                )
              ) : paid ? (
                '支付成功,额度已到账'
              ) : order?.channel === 'wechat' ? (
                '请使用微信扫描下方二维码完成付款'
              ) : (
                '请使用支付宝扫描下方二维码完成付款'
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

        {step === 'select' ? (
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
        ) : (
          <QrStep order={order!} paid={paid} onClose={onClose} />
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
  onChannelChange: (c: PaymentChannel) => void;
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
            <li>选择档位后点击「立即支付」,生成二维码,使用支付宝或微信扫码付款。</li>
            <li>支付成功后,所购买的发送额度将立即添加到您的账户。</li>
            <li>额度永久有效,不会过期 —— 用多少扣多少。</li>
            <li>如有支付问题或想要批量采购,请联系平台管理员。</li>
          </ol>

          <div className="mt-4 border-t pt-3">
            <div className="mb-2 text-xs font-semibold text-muted-foreground">支付方式</div>
            <ChannelToggle value={channel} onChange={onChannelChange} disabled={submitting} />
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

/** Tiny segmented control for the payment channel. Lives next to the
 *  action buttons because it's a checkout-time choice (the QR is
 *  channel-specific — Alipay's QR can't be scanned by WeChat and v.v.).
 *
 *  When selected, the button shows the brand color outline + colored
 *  brand mark; when unselected, it greys out (still legible, but visually
 *  recedes) so the active choice is unambiguous from across the room. */
function ChannelToggle({
  value,
  onChange,
  disabled,
}: {
  value: PaymentChannel;
  onChange: (c: PaymentChannel) => void;
  disabled?: boolean;
}) {
  const opts: {
    id: PaymentChannel;
    label: string;
    icon: typeof AlipayMark;
    /** Brand hex from each provider's design guidelines. */
    color: string;
  }[] = [
    { id: 'alipay', label: '支付宝', icon: AlipayMark, color: '#1677FF' },
    { id: 'wechat', label: '微信', icon: WechatMark, color: '#07C160' },
  ];
  return (
    <div role="group" aria-label="支付方式" className="inline-flex gap-1.5">
      {opts.map((o) => {
        const active = value === o.id;
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-all',
              active
                ? 'border-2 bg-background shadow-sm'
                : 'border-border bg-background text-muted-foreground hover:border-muted-foreground/40',
              disabled && 'cursor-not-allowed opacity-60',
            )}
            style={active ? { borderColor: o.color, color: o.color } : undefined}
          >
            <Icon className="size-4" color={active ? o.color : undefined} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Alipay brand mark — simplified inline SVG (rounded square + the 「支」
 *  character that's the recognisable element of Alipay's logo). When
 *  `color` is provided, it's used as the badge fill; otherwise we render
 *  in muted greyscale so the unselected state visually recedes. */
function AlipayMark({ className, color }: { className?: string; color?: string }) {
  const fill = color ?? '#9ca3af';
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <rect width="24" height="24" rx="5" fill={fill} />
      <path
        d="M19.5 17.1c-.6-.2-2.6-.9-4.5-1.7.5-.8.9-1.7 1.2-2.7h-2.5v-1h3.1v-.6h-3.1V9.6h-1.3c-.2 0-.2.2-.2.2v1.3H8.7v.6h3.5v1H9.4v.5h5.7c-.2.7-.5 1.4-.9 2-2-.6-4-1-5.3-.7-.8.2-1.4.5-1.7 1-1.4 2 .8 3.4 3 3.4 1.5 0 2.9-.6 4-1.6 1.7.8 5.1 2.2 5.1 2.2v-2.4zM9.5 16.6c-1.4 0-1.9-.5-2-1.1-.1-.5.4-1.1 1.4-1.3.6-.1 1.7 0 3.4.5-.7.9-1.7 1.9-2.8 1.9z"
        fill="white"
      />
    </svg>
  );
}

/** WeChat brand mark — simplified inline SVG (rounded square + a stylised
 *  speech-bubble pair, the recognisable element of WeChat's logo). */
function WechatMark({ className, color }: { className?: string; color?: string }) {
  const fill = color ?? '#9ca3af';
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <rect width="24" height="24" rx="5" fill={fill} />
      <path
        d="M9.5 6.3c-2.6 0-4.7 1.7-4.7 3.9 0 1.2.7 2.3 1.8 3l-.4 1.4 1.6-.8c.6.1 1 .2 1.7.2.2 0 .3 0 .5 0-.1-.3-.2-.7-.2-1 0-2.1 1.9-3.8 4.4-3.8.2 0 .3 0 .5 0-.4-1.7-2.4-2.9-4.7-2.9zM7.9 8.6c-.4 0-.7-.3-.7-.7 0-.4.3-.7.7-.7.4 0 .7.3.7.7 0 .4-.3.7-.7.7zm3.3 0c-.4 0-.7-.3-.7-.7 0-.4.3-.7.7-.7.4 0 .7.3.7.7 0 .4-.3.7-.7.7zm8 1.7c0-1.8-1.8-3.3-4-3.3s-4 1.5-4 3.3 1.8 3.3 4 3.3c.5 0 .9 0 1.4-.1l1.3.7-.3-1.1c.9-.5 1.6-1.4 1.6-2.4v-.4zm-5.4-.6c-.3 0-.6-.2-.6-.6 0-.3.2-.6.6-.6s.6.2.6.6c0 .3-.2.6-.6.6zm2.7 0c-.3 0-.6-.2-.6-.6 0-.3.2-.6.6-.6s.6.2.6.6c0 .3-.2.6-.6.6z"
        fill="white"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — show QR + poll status
// ---------------------------------------------------------------------------

function QrStep({
  order,
  paid,
  onClose,
}: {
  order: CreateQuotaOrderResponse;
  paid: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 p-8">
      <div className="relative rounded-lg border bg-white p-4">
        <QRCodeSVG value={order.qrCode} size={220} level="M" />
        {paid && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/95 backdrop-blur-sm">
            <CheckCircle2 className="size-20 text-emerald-500" strokeWidth={1.5} />
          </div>
        )}
      </div>

      <div className="text-center">
        <div className="text-2xl font-semibold tabular-nums">¥{order.amountCny.toFixed(2)}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          ≈ US${order.amountUsd.toFixed(2)}
        </div>
      </div>

      <div className="text-sm font-medium">
        {paid ? (
          <span className="text-emerald-600">支付成功,额度已到账</span>
        ) : (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            等待用户扫码支付…
          </span>
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        订单号: <span className="tabular-nums">{order.orderId}</span>
      </div>

      <div className="mt-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          {paid ? '关闭' : '取消'}
        </Button>
      </div>
    </div>
  );
}
