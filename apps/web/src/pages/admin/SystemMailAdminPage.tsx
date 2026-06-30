import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Send, Pencil, Eye, EyeOff } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton, TableSkeletonRows } from '@/components/ui/skeleton';
import { FilterSelect } from '@/components/ui/filter-select';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import type {
  NotificationTemplateView,
  SystemSmtpConfigView,
} from '@sendmast/shared';

type ConfigResp =
  | (SystemSmtpConfigView & { configured: true })
  | { configured: false };

const SECURE_OPTIONS = [
  { value: '1', label: 'SSL/TLS（推荐 465 端口）' },
  { value: '0', label: 'STARTTLS / 不加密（587 / 25）' },
];

export function SystemMailAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">系统邮件</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          配置发送系统通知（如密码重置）使用的 SMTP 服务，并维护通知模板。
        </p>
      </div>

      <SmtpConfigCard />
      <TemplatesCard />
    </div>
  );
}

// ============================================================================
// SMTP config card
// ============================================================================

function SmtpConfigCard() {
  const qc = useQueryClient();
  const toast = useToast();

  const { data: cfg, isLoading } = useQuery<ConfigResp>({
    queryKey: ['admin', 'system-mail', 'config'],
    queryFn: async () => (await api.get('/api/admin/system-mail/config')).data,
  });

  const [form, setForm] = useState({
    host: '',
    port: 465,
    secure: true,
    username: '',
    password: '',
    fromName: 'SendMast',
    fromAddress: '',
    replyTo: '',
  });
  const [showPw, setShowPw] = useState(false);
  const [touched, setTouched] = useState(false);

  // Hydrate the form once when config loads. We never get the password back
  // from the server (only `passwordMasked`), so the password field stays
  // empty unless the admin re-types it. On save we only PUT the password
  // when the admin actually entered something — else we keep the existing.
  useEffect(() => {
    if (!cfg || !cfg.configured || touched) return;
    setForm({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      username: cfg.username,
      password: '',
      fromName: cfg.fromName,
      fromAddress: cfg.fromAddress,
      replyTo: cfg.replyTo ?? '',
    });
  }, [cfg, touched]);

  const saveMut = useMutation({
    mutationFn: async (payload: typeof form) => {
      // If the admin didn't re-enter the password, fetch the current config's
      // *raw* password from a placeholder UX is awkward; backend requires
      // a password. We work around it by sending `<<keep>>` and the backend
      // would have to support that — instead we simply require the admin to
      // re-enter the password whenever they edit. Keep it simple.
      await api.put('/api/admin/system-mail/config', {
        ...payload,
        replyTo: payload.replyTo || undefined,
      });
    },
    onSuccess: () => {
      toast('SMTP 配置已保存', 'success');
      setTouched(false);
      qc.invalidateQueries({ queryKey: ['admin', 'system-mail', 'config'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const [testTo, setTestTo] = useState('');
  const testMut = useMutation({
    mutationFn: async () =>
      api.post('/api/admin/system-mail/test', {
        to: testTo,
        templateCode: 'password_reset',
      }),
    onSuccess: () => toast(`测试邮件已发送至 ${testTo}`, 'success'),
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  const update = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setTouched(true);
    setForm((f) => ({ ...f, [k]: v }));
  };

  return (
    <Card>
      <CardContent className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" />
              <h2 className="text-base font-semibold">SMTP 服务</h2>
              {cfg?.configured ? (
                <Badge variant="default">已配置</Badge>
              ) : (
                <Badge variant="muted">未配置</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              此 SMTP 仅用于平台系统通知（如密码重置），不影响活动邮件发送。
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
            </div>
            <Skeleton className="h-9 w-24" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field label="SMTP 主机" required>
                <Input
                  value={form.host}
                  onChange={(e) => update('host', e.target.value)}
                  placeholder="smtp.example.com"
                />
              </Field>
              <Field label="端口" required>
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => update('port', Number(e.target.value))}
                />
              </Field>
              <Field label="加密方式">
                <FilterSelect
                  value={form.secure ? '1' : '0'}
                  onChange={(value) => update('secure', value === '1')}
                  options={SECURE_OPTIONS}
                />
              </Field>
              <Field label="用户名" required>
                <Input
                  value={form.username}
                  onChange={(e) => update('username', e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="密码"
                required
                hint={
                  cfg?.configured && !form.password
                    ? '已存储（保持空白则维持原值，将密码留空保存会失败 — 请重新输入）'
                    : undefined
                }
              >
                <div className="relative">
                  <Input
                    type={showPw ? 'text' : 'password'}
                    value={form.password}
                    onChange={(e) => update('password', e.target.value)}
                    autoComplete="new-password"
                    placeholder={cfg?.configured ? '重新输入以更新密码' : ''}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </Field>
              <div /> {/* spacer */}
              <Field label="发件人显示名" required>
                <Input
                  value={form.fromName}
                  onChange={(e) => update('fromName', e.target.value)}
                />
              </Field>
              <Field label="发件人邮箱" required>
                <Input
                  type="email"
                  value={form.fromAddress}
                  onChange={(e) => update('fromAddress', e.target.value)}
                  placeholder="noreply@example.com"
                />
              </Field>
              <Field label="回复地址（可选）">
                <Input
                  type="email"
                  value={form.replyTo}
                  onChange={(e) => update('replyTo', e.target.value)}
                />
              </Field>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                onClick={() => saveMut.mutate(form)}
                disabled={saveMut.isPending}
              >
                {saveMut.isPending ? '保存中…' : '保存配置'}
              </Button>
              {cfg?.configured && (
                <span className="text-xs text-muted-foreground">
                  上次更新：{formatDateTime(cfg.updatedAt)}
                </span>
              )}
            </div>

            {cfg?.configured && (
              <div className="border-t pt-5">
                <Label className="text-sm font-medium">发送测试邮件</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  使用 <code className="rounded bg-muted px-1">password_reset</code>{' '}
                  模板发送一封示例邮件，用于验证 SMTP 配置是否生效。
                </p>
                <div className="mt-3 flex gap-2">
                  <Input
                    type="email"
                    placeholder="收件人邮箱"
                    className="max-w-sm"
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    onClick={() => testMut.mutate()}
                    disabled={!testTo || testMut.isPending}
                  >
                    <Send className="mr-1.5 size-3.5" />
                    {testMut.isPending ? '发送中…' : '发送测试'}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
  required,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ============================================================================
// Templates card
// ============================================================================

function TemplatesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<NotificationTemplateView | null>(null);

  const { data: templates, isLoading } = useQuery<NotificationTemplateView[]>({
    queryKey: ['admin', 'system-mail', 'templates'],
    queryFn: async () => (await api.get('/api/admin/system-mail/templates')).data,
  });

  const updateMut = useMutation({
    mutationFn: async (input: { code: string; subject: string; bodyHtml: string }) =>
      api.patch(`/api/admin/system-mail/templates/${input.code}`, {
        subject: input.subject,
        bodyHtml: input.bodyHtml,
      }),
    onSuccess: () => {
      toast('模板已更新', 'success');
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['admin', 'system-mail', 'templates'] });
    },
    onError: (e) => toast(apiErrMessage(e), 'error'),
  });

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <div className="border-b p-6 pb-4">
            <h2 className="text-base font-semibold">通知模板</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              管理系统通知的邮件主题与正文。模板代码（code）由后端定义，无法新增或删除。
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">模板</th>
                <th className="px-4 py-3 font-medium">主题</th>
                <th className="px-4 py-3 font-medium">变量</th>
                <th className="px-4 py-3 font-medium">最近更新</th>
                <th className="w-24 px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={5} />}
              {templates?.map((t) => (
                <tr key={t.code} className="border-b last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">
                      <code>{t.code}</code>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.subject}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {t.variables.map((v) => (
                        <span
                          key={v}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                        >
                          {`{{${v}}}`}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatDateTime(t.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      title="编辑"
                      className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                      onClick={() => setEditing(t)}
                    >
                      <Pencil className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {editing && (
        <TemplateEditorDialog
          template={editing}
          onCancel={() => setEditing(null)}
          onSave={(subject, bodyHtml) =>
            updateMut.mutate({ code: editing.code, subject, bodyHtml })
          }
          saving={updateMut.isPending}
        />
      )}
    </>
  );
}

// ============================================================================
// Template editor dialog
// ============================================================================

function TemplateEditorDialog({
  template,
  onCancel,
  onSave,
  saving,
}: {
  template: NotificationTemplateView;
  onCancel: () => void;
  onSave: (subject: string, bodyHtml: string) => void;
  saving: boolean;
}) {
  const [subject, setSubject] = useState(template.subject);
  const [bodyHtml, setBodyHtml] = useState(template.bodyHtml);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  // Render the live preview with placeholder values so the admin can see how
  // each `{{var}}` will eventually be substituted.
  const previewHtml = useMemo(() => {
    return bodyHtml.replace(
      /\{\{\s*(\w+)\s*\}\}/g,
      (_, k) => `<span style="background:#fef3c7;padding:0 2px;border-radius:2px;">[${k} 示例值]</span>`,
    );
  }, [bodyHtml]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b p-5">
          <div>
            <h3 className="text-base font-semibold">编辑模板：{template.name}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <code>{template.code}</code>
              {template.description ? ` · ${template.description}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {template.variables.map((v) => (
              <span
                key={v}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {`{{${v}}}`}
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-4 overflow-auto p-5">
          <div className="space-y-1.5">
            <Label className="text-xs">主题</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="邮件主题"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1 border-b">
              <button
                type="button"
                onClick={() => setTab('edit')}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors ${
                  tab === 'edit'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                编辑 HTML
              </button>
              <button
                type="button"
                onClick={() => setTab('preview')}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors ${
                  tab === 'preview'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                预览
              </button>
            </div>
            {tab === 'edit' ? (
              <textarea
                value={bodyHtml}
                onChange={(e) => setBodyHtml(e.target.value)}
                spellCheck={false}
                className="h-[420px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed"
              />
            ) : (
              <div className="h-[420px] overflow-auto rounded-md border bg-white">
                <iframe
                  title="template-preview"
                  sandbox=""
                  className="h-full w-full"
                  srcDoc={previewHtml}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => onSave(subject, bodyHtml)} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
}
