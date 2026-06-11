import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, Loader2, Mail, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import type {
  SenderDomainDnsRecord,
  SenderDomainRecordKind,
  SenderDomainVerificationStatus,
  SenderDomainView,
  SenderUsernameView,
  TenantAcsAccountView,
} from '@sendmast/shared';

const RECORD_LABELS: Record<SenderDomainRecordKind, string> = {
  Domain: '域名所有权',
  SPF: 'SPF',
  DKIM: 'DKIM',
  DKIM2: 'DKIM (备用)',
  DMARC: 'DMARC',
};

export function SenderDomainAddPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const existingId = params.get('id');
  const [step, setStep] = useState(existingId ? 2 : 1);
  const [domainInput, setDomainInput] = useState('');
  const [acsChoice, setAcsChoice] = useState('');

  // ACS accounts assigned to this tenant. When more than one is assigned the
  // user must pick which ACS to provision the domain under (immutable after).
  const acsAccounts = useQuery<TenantAcsAccountView[]>({
    queryKey: ['sender-domains', 'acs-accounts'],
    queryFn: async () => (await api.get('/api/sender-domains/acs-accounts')).data,
    enabled: !existingId,
  });
  const multiAcs = (acsAccounts.data?.length ?? 0) > 1;
  useEffect(() => {
    if (acsChoice || !acsAccounts.data?.length) return;
    const primary = acsAccounts.data.find((a) => a.isPrimary) ?? acsAccounts.data[0];
    setAcsChoice(primary.id);
  }, [acsAccounts.data, acsChoice]);

  const detail = useQuery<SenderDomainView>({
    queryKey: ['sender-domains', existingId],
    queryFn: async () => (await api.get(`/api/sender-domains/${existingId}`)).data,
    enabled: !!existingId,
    // While Azure is still creating the domain (~20-40s), poll every 2s so the
    // DNS records appear automatically once provisioning finishes.
    refetchInterval: (q) => (q.state.data?.status === 'provisioning' ? 2000 : false),
  });

  // Derive the furthest step the domain has reached. setStep only ever moves
  // forward — that way users can navigate back to an earlier step (e.g. add
  // another sender) without the data layer snapping them past it again.
  // Linking the domain to the CommunicationService is auto-triggered by the
  // backend during verify(), so there's no separate UI step for it.
  useEffect(() => {
    const v = detail.data;
    if (!v) return;
    let target = 2;
    if (v.status === 'verified') {
      target = v.senderUsernames.length === 0 ? 3 : 4;
    }
    setStep((cur) => Math.max(cur, target));
  }, [detail.data]);

  const createMut = useMutation({
    mutationFn: (input: { domain: string; acsAccountId?: string }) =>
      api.post<SenderDomainView>('/api/sender-domains', input),
    onError: (err) => toast(`创建失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['sender-domains'] });
      setParams({ id: r.data.id });
      setStep(2);
    },
  });

  const verifyMut = useMutation({
    mutationFn: (id: string) => api.post<SenderDomainView>(`/api/sender-domains/${id}/verify`),
    onError: (err) => toast(`检测失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sender-domains'] });
      detail.refetch();
    },
  });

  // Fallback to the createMut response so step 2 doesn't blink empty during
  // the brief window between setParams() and the first detail fetch returning.
  const view = detail.data ?? createMut.data?.data;

  return (
    <div className="space-y-4">
      <Button variant="outline" size="icon" asChild className="shrink-0">
        <Link to="/settings/domains" aria-label="返回域名列表">
          <ArrowLeft className="size-5" />
        </Link>
      </Button>

      <Card>
        <CardContent className="p-6">
          <Stepper step={step} />

          {step === 1 && (
            <div className="mt-6 space-y-4">
              <h2 className="text-lg font-semibold">第一步：输入您的域名</h2>
              <p className="text-sm text-muted-foreground">
                请输入您拥有的域名（不要包含 https:// 或路径）。系统会为您注册该域名,并返回需要在您的 DNS 处添加的记录。
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="domain">域名</Label>
                <Input
                  id="domain"
                  placeholder="example.com"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                />
              </div>
              {multiAcs && (
                <div className="space-y-1.5">
                  <Label htmlFor="acs">ACS 账号</Label>
                  <select
                    id="acs"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={acsChoice}
                    onChange={(e) => setAcsChoice(e.target.value)}
                  >
                    {acsAccounts.data?.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.isPrimary ? ' · 主' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    域名提交后无法更改所属 ACS 账号,请谨慎选择。
                  </p>
                </div>
              )}
              {createMut.isError && (
                <div className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                  {apiErrMessage(createMut.error)}
                </div>
              )}
              <Button
                onClick={() =>
                  createMut.mutate({
                    domain: domainInput.trim(),
                    acsAccountId: multiAcs ? acsChoice || undefined : undefined,
                  })
                }
                disabled={
                  !domainInput.trim() || createMut.isPending || (multiAcs && !acsChoice)
                }
              >
                {createMut.isPending ? (
                  <>
                    <Loader2 className="mr-1 size-4 animate-spin" />
                    提交中...
                  </>
                ) : (
                  '生成 DNS 记录'
                )}
              </Button>
            </div>
          )}

          {step === 2 && view && view.status === 'provisioning' && (
            <ProvisioningCard domain={view.domain} />
          )}

          {step === 2 && view && view.status === 'failed' && (
            <FailedCard domain={view.domain} onBack={() => navigate('/settings/domains')} />
          )}

          {step === 2 && view && view.status !== 'provisioning' && view.status !== 'failed' && (
            <div className="mt-6 space-y-4">
              <h2 className="text-lg font-semibold">
                第二步：在域名 DNS 处添加以下记录
                <Badge className="ml-2" variant="muted">
                  {view.domain}
                </Badge>
              </h2>
              <p className="text-sm text-muted-foreground">
                请在您的 DNS 服务商处（Cloudflare / 阿里云 / 腾讯云 等）添加以下{' '}
                <b>全部</b> 记录（含 DMARC，均为必填）。DKIM 是 CNAME，其余是 TXT。DNS 生效通常需要几分钟到几小时。
              </p>

              {view.records.map((rec) => (
                <DnsRow
                  key={rec.kind}
                  record={rec}
                  state={view.states[rec.kind]?.status}
                />
              ))}

              <div className="flex items-center gap-2 pt-2">
                <Button onClick={() => verifyMut.mutate(view.id)} disabled={verifyMut.isPending}>
                  {verifyMut.isPending ? (
                    <>
                      <Loader2 className="mr-1 size-4 animate-spin" />
                      检测中...
                    </>
                  ) : (
                    '我已添加，开始检测'
                  )}
                </Button>
                {view.status === 'verified' && (
                  <Badge variant="success">
                    <Check className="mr-1 size-3" />
                    检测通过
                  </Badge>
                )}
                {verifyMut.isSuccess && view.status !== 'verified' && (
                  <span className="text-sm text-amber-600">
                    部分记录尚未生效，过几分钟再点一次"开始检测"刷新状态。
                  </span>
                )}
              </div>
            </div>
          )}

          {step === 3 && view && (
            <SenderUsernamesStepCard
              view={view}
              onContinue={() => setStep(4)}
            />
          )}

          {step === 4 && view && (
            <div className="mt-6 space-y-3">
              <h2 className="text-lg font-semibold">第四步：完成</h2>
              <p className="text-sm">
                <Badge variant="success">
                  <Check className="mr-1 size-3" />
                  已验证
                </Badge>{' '}
                <span className="ml-2 font-medium">{view.domain}</span> 已配置
                {' '}{view.senderUsernames.length}{' '}个发件人,现在可以创建邮件活动并使用以下地址发件:
              </p>
              <ul className="space-y-1 rounded-md border bg-muted/30 p-3 font-mono text-sm">
                {view.senderUsernames.map((u) => (
                  <li key={u.id}>{u.fullAddress}</li>
                ))}
              </ul>
              <div className="flex items-center gap-2 pt-2">
                <Button onClick={() => navigate('/settings/domains')}>返回域名列表</Button>
                <Button variant="outline" onClick={() => setStep(3)}>
                  继续添加发件人
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SenderUsernamesStepCard({
  view,
  onContinue,
}: {
  view: SenderDomainView;
  onContinue: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');

  const addMut = useMutation({
    mutationFn: () =>
      api.post<SenderUsernameView>(`/api/sender-domains/${view.id}/usernames`, {
        username: username.trim().toLowerCase(),
        displayName: displayName.trim() || undefined,
      }),
    onError: (err) => toast(`添加失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sender-domains', view.id] });
      qc.invalidateQueries({ queryKey: ['sender-domains'] });
      setUsername('');
      setDisplayName('');
    },
  });

  const removeMut = useMutation({
    mutationFn: (usernameId: string) =>
      api.delete(`/api/sender-domains/${view.id}/usernames/${usernameId}`),
    onError: (err) => toast(`删除失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sender-domains', view.id] });
      qc.invalidateQueries({ queryKey: ['sender-domains'] });
    },
  });

  return (
    <div className="mt-6 space-y-4">
      <h2 className="text-lg font-semibold">
        第三步：添加发件人邮箱
        <Badge className="ml-2" variant="muted">
          {view.domain}
        </Badge>
      </h2>
      <p className="text-sm text-muted-foreground">
        发件地址形如 <span className="font-mono">username@{view.domain}</span>。可以添加多个,例如{' '}
        <span className="font-mono">donotreply</span>、<span className="font-mono">marketing</span>、<span className="font-mono">support</span>。显示名是收件人邮箱客户端里看到的"From"名称。
      </p>

      <div className="rounded-md border p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr_auto] md:items-end">
          <div>
            <Label className="mb-1.5 block">用户名</Label>
            <div className="flex items-center gap-1">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="donotreply"
              />
              <span className="text-sm text-muted-foreground">@{view.domain}</span>
            </div>
          </div>
          <div>
            <Label className="mb-1.5 block">显示名(可选)</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="SendMast"
            />
          </div>
          <Button
            onClick={() => addMut.mutate()}
            disabled={!username.trim() || addMut.isPending}
          >
            {addMut.isPending ? (
              <>
                <Loader2 className="mr-1 size-4 animate-spin" />
                添加中...
              </>
            ) : (
              <>
                <Mail className="mr-1 size-4" />
                添加发件人
              </>
            )}
          </Button>
        </div>
      </div>

      {view.senderUsernames.length > 0 && (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">发件地址</th>
                <th className="px-4 py-2 font-medium">显示名</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {view.senderUsernames.map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="px-4 py-2 font-mono">{u.fullAddress}</td>
                  <td className="px-4 py-2 text-muted-foreground">{u.displayName || '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      title="删除"
                      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                      disabled={removeMut.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: '删除发件人',
                          description: (
                            <>
                              确定删除发件人 <span className="font-mono">{u.fullAddress}</span> 吗?该操作不可撤销。
                            </>
                          ),
                          confirmLabel: '删除',
                          variant: 'danger',
                        });
                        if (ok) removeMut.mutate(u.id);
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
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button onClick={onContinue} disabled={view.senderUsernames.length === 0}>
          完成
        </Button>
        {view.senderUsernames.length === 0 && (
          <span className="text-sm text-muted-foreground">至少添加一个发件人后才能完成。</span>
        )}
      </div>
    </div>
  );
}

/**
 * Shown in step 2 while the backend is still waiting on Azure ARM to create
 * the domain resource. Mounts when status === 'provisioning'; the parent
 * unmounts it as soon as DNS records arrive (status flips to 'pending').
 */
function ProvisioningCard({ domain }: { domain: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - t0) / 1000)),
      500,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="mt-6 rounded-lg border border-dashed p-6 text-center">
      <Loader2 className="mx-auto mb-3 size-6 animate-spin text-muted-foreground" />
      <h2 className="text-base font-semibold">
        正在注册 <span className="font-mono">{domain}</span>
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        系统正在为该域名生成 DKIM 密钥和 DNS 验证记录,通常需要 20–40 秒。
      </p>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        已等待 {seconds}s · 完成后会自动显示 DNS 记录
      </p>
    </div>
  );
}

function FailedCard({ domain, onBack }: { domain: string; onBack: () => void }) {
  return (
    <div className="mt-6 rounded-lg border border-red-300 bg-red-50/40 p-6">
      <h2 className="text-base font-semibold text-red-700">
        域名 <span className="font-mono">{domain}</span> 注册失败
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        系统未能完成域名注册,请删除该条记录后重试；如反复失败,请联系管理员。
      </p>
      <div className="mt-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          返回域名列表
        </Button>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const steps = ['输入域名', '添加 DNS 记录', '添加发件人', '完成'];
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const idx = i + 1;
        const active = step === idx;
        const done = step > idx;
        return (
          <li key={label} className="flex items-center gap-2">
            <div
              className={
                'flex size-7 items-center justify-center rounded-full text-xs font-medium ' +
                (done
                  ? 'bg-primary text-primary-foreground'
                  : active
                  ? 'bg-primary/15 text-primary border border-primary'
                  : 'bg-muted text-muted-foreground')
              }
            >
              {done ? <Check className="size-3.5" /> : idx}
            </div>
            <span className={active ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
            {idx < steps.length && <div className="mx-2 h-px w-12 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

const STATE_VARIANT: Record<SenderDomainVerificationStatus, 'success' | 'warning' | 'danger' | 'muted'> =
  {
    Verified: 'success',
    VerificationRequested: 'warning',
    NotStarted: 'muted',
    VerificationFailed: 'danger',
    CancellationRequested: 'muted',
    Unknown: 'muted',
  };

const STATE_LABEL: Record<SenderDomainVerificationStatus, string> = {
  Verified: '已生效',
  VerificationRequested: '检测中',
  NotStarted: '未检测',
  VerificationFailed: '未通过',
  CancellationRequested: '取消中',
  Unknown: '未知',
};

function DnsRow({
  record,
  state,
}: {
  record: SenderDomainDnsRecord;
  state: SenderDomainVerificationStatus | undefined;
}) {
  const [copied, setCopied] = useState<'name' | 'value' | null>(null);
  const verified = state === 'Verified';
  const failed = state === 'VerificationFailed';
  const borderClass = verified
    ? 'border border-emerald-300 bg-emerald-50/40'
    : failed
    ? 'border border-red-300 bg-red-50/40'
    : 'border';

  const copy = (text: string, field: 'name' | 'value') => {
    navigator.clipboard.writeText(text);
    setCopied(field);
    window.setTimeout(() => setCopied((cur) => (cur === field ? null : cur)), 1500);
  };

  return (
    <div className={`rounded-md p-3 ${borderClass}`}>
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="font-medium">{RECORD_LABELS[record.kind]}</span>
        {state && (
          <Badge variant={STATE_VARIANT[state]}>
            {state === 'Verified' && <Check className="mr-1 size-3" />}
            {state === 'VerificationFailed' && <X className="mr-1 size-3" />}
            {STATE_LABEL[state]}
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-[80px_320px_1fr] gap-3 text-xs">
        <div>
          <div className="text-muted-foreground">类型</div>
          <div className="mt-1 font-mono">{record.type}</div>
        </div>
        <div className="min-w-0">
          <div className="text-muted-foreground">主机</div>
          <div className="mt-1 break-all font-mono">
            {record.name}
            <CopyIconButton copied={copied === 'name'} onClick={() => copy(record.name, 'name')} />
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-muted-foreground">值</div>
          <div className="mt-1 break-all font-mono">
            {record.value}
            <CopyIconButton copied={copied === 'value'} onClick={() => copy(record.value, 'value')} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyIconButton({ copied, onClick }: { copied: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? '已复制' : '复制'}
      aria-label={copied ? '已复制' : '复制'}
      // inline-flex + align-middle so the button sits in the text flow right
      // after the last character of the host/value string and follows long
      // strings as they wrap, instead of being pushed to the row's right edge.
      className="ml-1 inline-flex items-center rounded p-0.5 align-middle text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}
