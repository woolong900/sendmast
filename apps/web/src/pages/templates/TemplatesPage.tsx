import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';

interface TemplateRow {
  id: string;
  name: string;
  category: string | null;
  scope: 'system' | 'user';
  thumbnail: string | null;
  updatedAt: string;
}

export function TemplatesPage() {
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">模板库</h1>
          <p className="mt-1 text-sm text-muted-foreground">挑选合适的主题模板，或创建你自己的模板。</p>
        </div>
        <Button asChild>
          <Link to="/templates/new">
            <Plus className="mr-1 size-4" />
            创建自定义模板
          </Link>
        </Button>
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

      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          系统模板 ({systemTpls.length})
        </h2>
        <TemplateGrid
          templates={systemTpls}
          loading={isLoading}
          empty={<EmptyState />}
        />
      </div>
    </div>
  );
}

function TemplateGrid({
  templates,
  loading,
  empty,
  onDelete,
  deletable,
  deleting,
}: {
  templates: TemplateRow[];
  loading: boolean;
  empty: React.ReactNode;
  onDelete?: (id: string) => void;
  deletable?: boolean;
  deleting?: boolean;
}) {
  const confirm = useConfirm();
  if (loading) return <div className="text-sm text-muted-foreground">加载中...</div>;
  if (templates.length === 0) return <Card><CardContent className="p-8">{empty}</CardContent></Card>;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {templates.map((t) => (
        <Card key={t.id} className="overflow-hidden transition-shadow hover:shadow-md">
          <Link to={`/templates/${t.id}/edit`}>
            <div className="flex aspect-[4/3] items-center justify-center bg-muted">
              {t.thumbnail ? (
                <img src={t.thumbnail} alt={t.name} className="h-full w-full object-cover" />
              ) : (
                <FileText className="size-8 text-muted-foreground" />
              )}
            </div>
          </Link>
          <CardContent className="p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link to={`/templates/${t.id}/edit`} className="block truncate text-sm font-medium hover:underline">
                  {t.name}
                </Link>
                {t.category && (
                  <Badge variant="muted" className="mt-1">
                    {t.category}
                  </Badge>
                )}
              </div>
              {deletable && onDelete && (
                <Button
                  size="icon"
                  variant="ghost"
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
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

