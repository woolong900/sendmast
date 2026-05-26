import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { api, apiErrMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import type {
  CreateTrackingDomainInput,
  TrackingDomainView,
} from '@sendmast/shared';

/**
 * Pool of tracking host names. See `model TrackingDomain` in schema.prisma
 * for product rationale (spread spam-complaint risk across many domains
 * instead of staking the primary app domain on customer behaviour).
 *
 * Workflow surfaced here is intentionally manual:
 *   1. Buy the domain, point its DNS at this server through Cloudflare proxy.
 *   2. Add the domain to the active Cloudflare Origin Cert SAN list, redeploy
 *      the cert files on the server.
 *   3. Drop the generated `<domain>.caddy` snippet into `docker/tracking.d/`,
 *      run `docker compose exec caddy caddy reload`.
 *   4. Click "添加" here. Status defaults to active and worker-sender starts
 *      using the host within ~30s (pool cache TTL).
 *
 * The "复制 Caddy 片段" button at the bottom of the form generates the snippet
 * for step 3 so there's no Caddyfile guesswork.
 */
export function AdminTrackingDomainsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<CreateTrackingDomainInput>({
    domain: '',
    notes: '',
  });

  const { data: domains = [], isLoading } = useQuery<TrackingDomainView[]>({
    queryKey: ['admin', 'tracking-domains'],
    queryFn: async () => (await api.get('/api/admin/tracking-domains')).data,
  });

  const createMut = useMutation({
    mutationFn: (input: CreateTrackingDomainInput) =>
      api.post('/api/admin/tracking-domains', input),
    onSuccess: () => {
      toast('域名已加入轮询池', 'success');
      setDraft({ domain: '', notes: '' });
      setShowCreate(false);
      qc.invalidateQueries({ queryKey: ['admin', 'tracking-domains'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const toggleMut = useMutation({
    mutationFn: (input: { id: string; status: 'active' | 'disabled' }) =>
      api.patch(`/api/admin/tracking-domains/${input.id}`, { status: input.status }),
    onSettled: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'tracking-domains'] }),
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/admin/tracking-domains/${id}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'tracking-domains'] }),
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  async function handleDelete(d: TrackingDomainView) {
    const ok = await confirm({
      title: '删除追踪域名',
      description: (
        <span>
          删除 <b className="font-mono">{d.domain}</b> 后,该域名不再参与轮询。<br />
          注意:已经发出去的邮件里仍然印着这个域名,删除前请确认相关 Caddy 配置和 DNS 是否要保留 ~24 小时,以免追踪 URL 失效。
        </span>
      ),
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    deleteMut.mutate(d.id);
  }

  async function copyCaddySnippet(domain: string) {
    try {
      await navigator.clipboard.writeText(buildCaddySnippet(domain));
      toast(`已复制 ${domain} 的 Caddy 配置片段`, 'success');
    } catch {
      toast('复制失败,请手动选择文本', 'error');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">追踪域名</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            邮件里的打开像素、点击重定向和退订链接都从这个池里挑域名(按收件人 hash 选)。
            分散到多个域名后,即使个别租户因发送行为不当导致一个域名被反垃圾邮件机构封禁,
            其他域名依然可用,不会牵连主站。<b>池为空时活动会直接失败</b>,请至少保留一个启用域名。
          </p>
        </div>
        <Button onClick={() => setShowCreate((v) => !v)} className="w-full sm:w-auto">
          <Plus className="mr-1 size-4" />
          添加域名
        </Button>
      </div>

      <UsageHint />

      {showCreate && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="td-domain">域名</Label>
              <Input
                id="td-domain"
                value={draft.domain}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, domain: e.target.value }))
                }
                placeholder="例如: t1.mailtrk.cn"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                只填裸域名,不要带 https:// 或路径。子域名也可以(推荐)。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="td-notes">备注(可选)</Label>
              <Textarea
                id="td-notes"
                value={draft.notes ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, notes: e.target.value }))
                }
                placeholder="注册商、购买日期、用途等,自己看的"
                rows={2}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() =>
                  createMut.mutate({
                    domain: draft.domain.trim(),
                    notes: draft.notes?.trim() || null,
                  })
                }
                disabled={!draft.domain.trim() || createMut.isPending}
              >
                {createMut.isPending ? '保存中…' : '添加并启用'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowCreate(false);
                  setDraft({ domain: '', notes: '' });
                }}
                disabled={createMut.isPending}
              >
                取消
              </Button>
              {draft.domain.trim() && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => copyCaddySnippet(draft.domain.trim().toLowerCase())}
                >
                  <Copy className="mr-1 size-3.5" />
                  复制 Caddy 片段(供 SSH 时使用)
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">域名</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">备注</th>
                  <th className="px-4 py-3 font-medium">添加时间</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      加载中...
                    </td>
                  </tr>
                )}
                {!isLoading && domains.length === 0 && (
                  <EmptyStateRow colSpan={5} title="暂无追踪域名 — 点右上角「添加域名」开始" />
                )}
                {domains.map((d) => (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{d.domain}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="cursor-pointer"
                        onClick={() =>
                          toggleMut.mutate({
                            id: d.id,
                            status: d.status === 'active' ? 'disabled' : 'active',
                          })
                        }
                        disabled={toggleMut.isPending}
                        title="点击切换启用/禁用"
                      >
                        {d.status === 'active' ? (
                          <Badge variant="success">启用</Badge>
                        ) : (
                          <Badge variant="muted">已禁用</Badge>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {d.notes ? (
                        <span className="block max-w-md truncate" title={d.notes}>
                          {d.notes}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatDateTime(d.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => copyCaddySnippet(d.domain)}
                          title="复制 Caddy 片段"
                        >
                          <Copy className="mr-1 size-3.5" />
                          Caddy 片段
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDelete(d)}
                          disabled={deleteMut.isPending}
                          title="删除域名"
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UsageHint() {
  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-4 text-sm text-blue-900">
      <div className="font-medium">添加新域名的步骤</div>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-blue-800/90">
        <li>购买域名,DNS 接入 Cloudflare(账号需与现有域同号)。</li>
        <li>
          在 Cloudflare 加 A 记录指向 <span className="font-mono">74.208.77.128</span>,
          <b>启用代理(橙云)</b>。
        </li>
        <li>
          Cloudflare 后台 → SSL/TLS → Origin Server → 找到现有 Origin Cert
          (或新建一个)→ 把这个域名加进 SAN 列表。
        </li>
        <li>
          重新下载 Origin Cert,scp 到服务器
          <span className="font-mono"> /root/sendmast/docker/certs/</span> 替换原文件。
        </li>
        <li>
          点本页"添加域名" → 复制 Caddy 片段 → scp 到服务器
          <span className="font-mono"> /root/sendmast/docker/tracking.d/&lt;domain&gt;.caddy</span>。
        </li>
        <li>
          SSH 跑 <span className="font-mono">docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile</span>。
        </li>
        <li>30 秒内 worker-sender 会把新域名加入轮询池。</li>
      </ol>
    </div>
  );
}

/**
 * Generate a Caddy site block for a tracking domain. Mirrors the existing
 * app/api site blocks: Cloudflare origin cert (mounted at the same path the
 * other site blocks reference), gzip/zstd, /t/* reverse proxy, everything
 * else 404 (we don't want this hostname leaking the SPA or the API).
 */
function buildCaddySnippet(domain: string): string {
  return `# Tracking domain: ${domain}
# Generated by SendMast admin UI. Drop into docker/tracking.d/ on the server,
# then run \`docker compose exec caddy caddy reload\`.
${domain} {
\ttls /etc/caddy/certs/origin-cert.pem /etc/caddy/certs/origin-key.pem
\tencode gzip zstd

\thandle /t/* {
\t\treverse_proxy api:4000
\t}

\thandle {
\t\trespond "Not Found" 404
\t}

\theader {
\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"
\t\tX-Content-Type-Options nosniff
\t}

\tlog {
\t\toutput stdout
\t\tformat console
\t}
}
`;
}
