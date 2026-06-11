import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';
import { api, apiErrMessage } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/utils';

interface ContactListView {
  id: string;
  name: string;
  description: string | null;
  contactsCount: number;
  createdAt: string;
}

interface ContactListsResponse {
  items: ContactListView[];
  total: number;
  page: number;
  pageSize: number;
}

export function ContactListsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    setPage(1);
  }, [search]);

  const { data, isLoading } = useQuery<ContactListsResponse>({
    queryKey: ['contact-lists', search, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      return (await api.get(`/api/contact-lists?${params}`)).data;
    },
    // Keep prior rows visible while paginating within the same search term;
    // a search change shows a fresh load instead of stale rows.
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey as unknown[] | undefined;
      return k && k[1] === search ? prev : undefined;
    },
  });

  const createMut = useMutation({
    mutationFn: (vars: { name: string; description?: string }) =>
      api.post('/api/contact-lists', vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contact-lists'] });
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/contact-lists/${id}`),
    onError: (err) => toast(`删除失败:${apiErrMessage(err)}`, 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['contact-lists'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">联系人</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理你的联系人列表，可分组、导入、维护订阅状态。</p>
        </div>
        <Button onClick={() => setShowCreate((v) => !v)} className="w-full sm:w-auto">
          <Plus className="mr-1 size-4" />
          新建列表
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="ln">名称</Label>
              <Input id="ln" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例如：新订阅用户" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ld">描述</Label>
              <Input id="ld" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="可选" />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => createMut.mutate({ name: newName.trim(), description: newDesc.trim() || undefined })}
                disabled={!newName.trim() || createMut.isPending}
              >
                {createMut.isPending ? '创建中...' : '创建'}
              </Button>
              <Button variant="ghost" onClick={() => setShowCreate(false)}>
                取消
              </Button>
            </div>
            {createMut.isError && (
              <div className="text-sm text-destructive">{apiErrMessage(createMut.error)}</div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="按列表名称搜索"
              className="pl-8"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">联系人数</th>
                <th className="px-4 py-3 font-medium">创建时间</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={4} />}
              {!isLoading && data && data.items.length === 0 && <EmptyStateRow colSpan={4} />}
              {data?.items.map((l) => {
                const href = `/contacts/lists/${l.id}`;
                return (
                  <tr
                    key={l.id}
                    // Whole-row click navigates to the list — same as clicking
                    // the name. Keeping the inner <Link> means cmd/ctrl-click
                    // and right-click "open in new tab" still work natively.
                    onClick={() => navigate(href)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        navigate(href);
                      }
                    }}
                    tabIndex={0}
                    role="link"
                    aria-label={`打开列表 ${l.name}`}
                    className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={href}
                        // Stop propagation so the row's onClick doesn't also
                        // fire on top of the Link's own navigation. Harmless
                        // either way (navigate is idempotent), but cleaner.
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium hover:underline"
                      >
                        {l.name}
                      </Link>
                      {l.description && (
                        <div className="text-xs text-muted-foreground">{l.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">{formatNumber(l.contactsCount)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDateTime(l.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        title="删除"
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                        disabled={deleteMut.isPending}
                        onClick={async (e) => {
                          // Don't navigate when interacting with the delete
                          // button — without this, clicking trash would open
                          // the list AND ask to delete it.
                          e.stopPropagation();
                          const ok = await confirm({
                            title: '删除联系人列表',
                            description: (
                              <>
                                确定删除列表「<span className="font-medium">{l.name}</span>」吗?联系人本身不会被删除,但该列表下的分组关系会丢失。
                              </>
                            ),
                            confirmLabel: '删除',
                            variant: 'danger',
                          });
                          if (ok) deleteMut.mutate(l.id);
                        }}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {data && data.total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
              <span>共 {formatNumber(data.total)} 个列表</span>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={data.total}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
