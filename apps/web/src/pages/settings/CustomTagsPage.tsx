import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Plus, Tag, Trash2, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { api, apiErrMessage } from '@/lib/api';
import type { CustomTagView } from '@sendmast/shared';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';

type EditorState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; tag: CustomTagView };

export function CustomTagsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });

  const list = useQuery<CustomTagView[]>({
    queryKey: ['custom-tags'],
    queryFn: async () => (await api.get('/api/custom-tags')).data,
  });

  const createMut = useMutation({
    mutationFn: (input: { name: string; values: string[] }) =>
      api.post('/api/custom-tags', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-tags'] });
      toast('已创建自定义标签', 'success');
      setEditor({ mode: 'closed' });
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, values }: { id: string; values: string[] }) =>
      api.patch(`/api/custom-tags/${id}`, { values }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-tags'] });
      toast('已保存', 'success');
      setEditor({ mode: 'closed' });
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/custom-tags/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-tags'] });
      toast('已删除', 'success');
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制占位符', 'success');
    } catch {
      toast('复制失败，请手动复制', 'error');
    }
  };

  const testRandom = (tag: CustomTagView) => {
    if (tag.values.length === 0) return;
    const v = tag.values[Math.floor(Math.random() * tag.values.length)];
    toast(`随机抽中：${v}`, 'success');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-xl font-semibold">自定义标签</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            创建和管理邮件模板中的自定义变量
          </p>
        </div>
        <Button onClick={() => setEditor({ mode: 'create' })} className="w-full sm:w-auto">
          <Plus className="mr-1 size-4" />
          创建标签
        </Button>
      </div>

      <UsageHint />

      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-6 py-3 text-left font-medium">标签名称</th>
              <th className="px-6 py-3 text-left font-medium">占位符</th>
              <th className="px-6 py-3 text-left font-medium">标签值列表</th>
              <th className="px-6 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && <TableSkeletonRows columns={4} cellClassName="px-6 py-4" />}
            {!list.isLoading && (list.data?.length ?? 0) === 0 && (
              <EmptyStateRow colSpan={4} />
            )}
            {list.data?.map((t) => {
              const placeholder = `{{tag:${t.name}}}`;
              return (
                <tr key={t.id} className="border-b last:border-b-0">
                  <td className="px-6 py-4 align-middle">
                    <span className="font-medium uppercase tracking-wide">{t.name}</span>
                  </td>
                  <td className="px-6 py-4 align-middle">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-purple-50 px-2 py-1 font-mono text-xs text-purple-700">
                        {placeholder}
                      </code>
                      <button
                        type="button"
                        onClick={() => copy(placeholder)}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                        title="复制占位符"
                      >
                        <Copy className="size-3.5" />
                      </button>
                    </div>
                  </td>
                  <td className="px-6 py-4 align-middle">
                    <span
                      className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700"
                      title={t.values.join(' / ')}
                    >
                      {t.values.length} 个值
                    </span>
                  </td>
                  <td className="px-6 py-4 align-middle">
                    <div className="flex items-center justify-end gap-1 text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => testRandom(t)}
                        className="rounded p-1.5 transition-colors hover:bg-muted hover:text-amber-600"
                        title="测试随机"
                      >
                        <Zap className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditor({ mode: 'edit', tag: t })}
                        className="rounded p-1.5 transition-colors hover:bg-muted hover:text-foreground"
                        title="编辑"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await confirm({
                            title: '删除自定义标签？',
                            description: `占位符 ${placeholder} 在已发送/计划中的活动里将不再被替换。`,
                            variant: 'danger',
                            confirmLabel: '删除',
                          });
                          if (ok) deleteMut.mutate(t.id);
                        }}
                        className="rounded p-1.5 transition-colors hover:bg-muted hover:text-destructive"
                        title="删除"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {editor.mode !== 'closed' && (
        <TagEditorModal
          initial={editor.mode === 'edit' ? editor.tag : null}
          onClose={() => setEditor({ mode: 'closed' })}
          onSubmit={(input) => {
            if (editor.mode === 'edit') {
              updateMut.mutate({ id: editor.tag.id, values: input.values });
            } else {
              createMut.mutate(input);
            }
          }}
          submitting={createMut.isPending || updateMut.isPending}
        />
      )}
    </div>
  );
}

// -- Blue usage-hint card ----------------------------------------------------

function UsageHint() {
  return (
    <div className="flex gap-3 rounded-lg border border-blue-100 bg-blue-50/60 p-4 text-sm text-blue-900">
      <Tag className="mt-0.5 size-4 shrink-0 text-blue-600" />
      <div className="space-y-1">
        <div className="font-medium">如何使用自定义标签？</div>
        <ul className="list-disc space-y-0.5 pl-5 text-blue-800/90">
          <li>
            在活动的主题或内容中使用{' '}
            <code className="rounded bg-white/70 px-1 py-0.5 font-mono text-xs text-blue-700">
              {'{{tag:name}}'}
            </code>
          </li>
          <li>发送时会自动替换为标签的值</li>
          <li>如果标签有多个值（多行），系统会随机选择一个，每位收件人独立随机</li>
          <li>
            例如：
            <code className="rounded bg-white/70 px-1 py-0.5 font-mono text-xs text-blue-700">
              {'{{tag:company_name}}'}
            </code>{' '}
            会替换为具体的公司名称
          </li>
        </ul>
      </div>
    </div>
  );
}

// -- Editor modal ------------------------------------------------------------

function TagEditorModal({
  initial,
  onClose,
  onSubmit,
  submitting,
}: {
  initial: CustomTagView | null;
  onClose: () => void;
  onSubmit: (input: { name: string; values: string[] }) => void;
  submitting: boolean;
}) {
  const isEdit = initial !== null;
  const [name, setName] = useState(initial?.name ?? '');
  const [valuesText, setValuesText] = useState(initial?.values.join('\n') ?? '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const values = parseValues(valuesText);
  const trimmedName = name.trim().toLowerCase();
  const placeholder = trimmedName ? `{{tag:${trimmedName}}}` : '{{tag:name}}';
  const canSubmit = !submitting && !!trimmedName && values.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ name: trimmedName, values });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-semibold">
            {isEdit ? '编辑标签' : '创建标签'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <label className="text-xs font-medium text-muted-foreground">标签名</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 company_name"
              maxLength={40}
              disabled={isEdit}
              className="mt-1"
              autoFocus={!isEdit}
            />
            <div className="mt-1 text-xs text-muted-foreground">
              占位符：
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{placeholder}</code>
              {isEdit && '（标签名创建后不可修改）'}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              候选值（每行一个，发送时随机选一个）
            </label>
            <Textarea
              value={valuesText}
              onChange={(e) => setValuesText(e.target.value)}
              placeholder={'你好\nHi\nHello'}
              rows={8}
              className="mt-1 font-mono text-sm"
              autoFocus={isEdit}
            />
            <div className="mt-1 text-xs text-muted-foreground">
              当前 {values.length} 个有效值
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t bg-muted/20 px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {isEdit ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// One value per line; trim and drop empty lines. Mirrors server-side dedupe
// just for the submit-button enabled state.
function parseValues(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
