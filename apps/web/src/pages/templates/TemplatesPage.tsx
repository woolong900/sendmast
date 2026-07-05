import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, FileText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { applyMergePreviewSamples } from '@/lib/email-merge-preview';
import { EmptyState } from '@/components/ui/empty-state';

interface TemplateRow {
  id: string;
  name: string;
  scope: 'system' | 'user';
  thumbnail: string | null;
  updatedAt: string;
}

interface TemplatePreview {
  id: string;
  name: string;
  scope: 'system' | 'user';
  html: string;
}

export function TemplatesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  // System templates are read-only. Opening the editor route just for the
  // iframe preview used to tear down this page (and its scroll position). Keep
  // the selected row here so browsing a few system templates stays in the
  // library instead.
  const [previewing, setPreviewing] = useState<TemplateRow | null>(null);
  const { data, isLoading } = useQuery<TemplateRow[]>({
    queryKey: ['templates'],
    queryFn: async () => (await api.get('/api/templates')).data,
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/templates/${id}`),
    onError: (err) => toast(`删除失败:${apiErrMessage(err)}`, 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });

  const userTpls = data?.filter((t) => t.scope === 'user') ?? [];
  const systemTpls = data?.filter((t) => t.scope === 'system') ?? [];

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">模板库</h1>
            <p className="mt-1 text-sm text-muted-foreground">挑选合适的主题模板，或创建你自己的模板。</p>
          </div>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/templates/new">
              <Plus className="mr-1 size-4" />
              创建自定义模板
            </Link>
          </Button>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            系统模板 ({systemTpls.length})
          </h2>
          <TemplateGrid
            templates={systemTpls}
            loading={isLoading}
            empty={<EmptyState />}
            onPreview={(template) => setPreviewing(template)}
          />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            我的模板 ({userTpls.length})
          </h2>
          <TemplateGrid
            templates={userTpls}
            loading={isLoading}
            empty={<EmptyState />}
            onDelete={(id) => deleteMut.mutate(id)}
            deleting={deleteMut.isPending}
            deletable
          />
        </div>
      </div>

      {previewing && (
        <SystemTemplatePreview
          // Reset title/focus/loading correctly when another card is opened.
          key={previewing.id}
          template={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}
    </>
  );
}

function TemplateGrid({
  templates,
  loading,
  empty,
  onDelete,
  onPreview,
  deletable,
  deleting,
}: {
  templates: TemplateRow[];
  loading: boolean;
  empty: React.ReactNode;
  onDelete?: (id: string) => void;
  onPreview?: (template: TemplateRow) => void;
  deletable?: boolean;
  deleting?: boolean;
}) {
  const confirm = useConfirm();
  if (loading)
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="overflow-hidden">
            <Skeleton className="aspect-[4/3] w-full rounded-none" />
            <CardContent className="space-y-2 p-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  if (templates.length === 0) return <Card><CardContent className="p-8">{empty}</CardContent></Card>;

  const cover = (t: TemplateRow) => (
    <div className="flex aspect-[4/3] items-center justify-center bg-muted">
      {t.thumbnail ? (
        <img src={t.thumbnail} alt={t.name} className="h-full w-full object-cover" />
      ) : (
        <FileText className="size-8 text-muted-foreground" />
      )}
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {templates.map((t) => {
        // System rows aren't editable. Make the whole card one button so both
        // the cover and the title open an in-page preview (and keyboard users
        // only tab to one target). User templates keep their edit link/actions.
        if (t.scope === 'system' && onPreview) {
          return (
            <Card key={t.id} className="overflow-hidden transition-shadow hover:shadow-md">
              <button
                type="button"
                onClick={() => onPreview(t)}
                aria-label={`预览系统模板 ${t.name}`}
                className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              >
                {cover(t)}
                <CardContent className="p-3">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                </CardContent>
              </button>
            </Card>
          );
        }

        return (
          <Card key={t.id} className="overflow-hidden transition-shadow hover:shadow-md">
            <Link to={`/templates/${t.id}/edit`}>{cover(t)}</Link>
            <CardContent className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to={`/templates/${t.id}/edit`} className="block truncate text-sm font-medium hover:underline">
                    {t.name}
                  </Link>
                </div>
                {deletable && onDelete && (
                  <button
                    type="button"
                    title="删除"
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                    disabled={deleting}
                    onClick={async () => {
                      const ok = await confirm({
                        title: '删除模板',
                        description: (
                          <>
                            确定删除模板「<span className="font-medium">{t.name}</span>」吗?该操作不可撤销。
                          </>
                        ),
                        confirmLabel: '删除',
                        variant: 'danger',
                      });
                      if (ok) onDelete(t.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/** Lightweight, read-only preview for a system template in the library. */
function SystemTemplatePreview({
  template,
  onClose,
}: {
  template: TemplateRow;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Fetch the full template only when the modal opens. The library rows are
  // intentionally small; this also never opens /templates/:id/edit.
  const detail = useQuery<TemplatePreview>({
    queryKey: ['templates', template.id],
    queryFn: async () => (await api.get(`/api/templates/${template.id}`)).data,
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      // Return focus to the card just opened, rather than the top of the page.
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  // Portal avoids clipping inside Layout's scroll container; the list stays
  // mounted under the backdrop so closing the modal is instant.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-[92vh] max-h-[900px] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-background shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold">
              {detail.data?.name ?? template.name}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              系统模板 · 仅预览（变量为示例内容，实际发送会替换为真实信息）
            </p>
          </div>
          <Button ref={closeRef} type="button" variant="ghost" size="sm" onClick={onClose} aria-label="关闭预览">
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 bg-muted/30 p-4">
          {detail.isLoading ? (
            <div className="mx-auto flex h-full w-full max-w-[640px] flex-col overflow-hidden rounded-lg border bg-background p-5 shadow-sm">
              <Skeleton className="mb-4 h-5 w-32" />
              <Skeleton className="mb-3 h-4 w-full" />
              <Skeleton className="mb-5 h-4 w-2/3" />
              <Skeleton className="w-full flex-1" />
            </div>
          ) : detail.isError ? (
            <div className="m-auto flex flex-col items-center gap-3 rounded-lg border bg-background px-8 py-6 text-center">
              <p className="text-sm text-muted-foreground">
                预览加载失败：{apiErrMessage(detail.error)}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void detail.refetch()}>
                重试
              </Button>
            </div>
          ) : detail.data?.html ? (
            <iframe
              title={`${detail.data.name} 预览`}
              srcDoc={applyMergePreviewSamples(detail.data.html)}
              className="mx-auto block h-full w-full max-w-[640px] rounded-lg border bg-white shadow-sm"
              sandbox=""
            />
          ) : (
            <div className="m-auto text-sm text-muted-foreground">暂无可预览的内容</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
