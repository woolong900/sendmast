import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, FileText, Eye, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { applyMergePreviewSamples } from '@/lib/email-merge-preview';

interface TemplateRow {
  id: string;
  name: string;
  scope: 'system' | 'user';
  thumbnail: string | null;
  html: string;
  updatedAt: string;
}

export function TemplatesPage() {
  const [previewTemplate, setPreviewTemplate] = useState<TemplateRow | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
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
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">模板库</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            挑选合适的主题模板，或创建你自己的模板。
          </p>
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
          onPreview={setPreviewTemplate}
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

      {previewTemplate && (
        <SystemTemplatePreview
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
        />
      )}
    </div>
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
  if (templates.length === 0)
    return (
      <Card>
        <CardContent className="p-8">{empty}</CardContent>
      </Card>
    );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {templates.map((t) => (
        <Card key={t.id} className="overflow-hidden transition-shadow hover:shadow-md">
          {onPreview ? (
            <button
              type="button"
              className="group relative block w-full text-left"
              onClick={() => onPreview(t)}
              aria-label={`预览${t.name}`}
            >
              <TemplateThumbnail template={t} />
              <span className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-black/35 group-hover:opacity-100 group-focus-visible:bg-black/35 group-focus-visible:opacity-100">
                <Eye className="size-4" />
                预览
              </span>
            </button>
          ) : (
            <Link to={`/templates/${t.id}/edit`}>
              <TemplateThumbnail template={t} />
            </Link>
          )}
          <CardContent className="p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {onPreview ? (
                  <button
                    type="button"
                    className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                    onClick={() => onPreview(t)}
                  >
                    {t.name}
                  </button>
                ) : (
                  <Link
                    to={`/templates/${t.id}/edit`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {t.name}
                  </Link>
                )}
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
                          确定删除模板「<span className="font-medium">{t.name}</span>
                          」吗?该操作不可撤销。
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
      ))}
    </div>
  );
}

function TemplateThumbnail({ template }: { template: TemplateRow }) {
  return (
    <div className="flex aspect-[4/3] items-center justify-center bg-muted">
      {template.thumbnail ? (
        <img
          src={template.thumbnail}
          alt={template.name}
          className="h-full w-full object-contain object-left-top"
        />
      ) : (
        <FileText className="size-8 text-muted-foreground" />
      )}
    </div>
  );
}

function SystemTemplatePreview({
  template,
  onClose,
}: {
  template: TemplateRow;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-template-preview-title"
        className="flex h-[min(900px,calc(100vh-24px))] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-background shadow-xl sm:h-[min(900px,calc(100vh-48px))]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
          <div className="min-w-0">
            <h2 id="system-template-preview-title" className="truncate text-sm font-semibold">
              {template.name}
            </h2>
            <p className="text-xs text-muted-foreground">系统模板预览</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭预览"
            autoFocus
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-muted/30 p-3 sm:p-5">
          <iframe
            title={`${template.name}预览`}
            srcDoc={applyMergePreviewSamples(template.html)}
            className="mx-auto block h-full w-full max-w-[680px] rounded-md border bg-white shadow-sm"
            sandbox=""
          />
        </div>
      </div>
    </div>
  );
}
