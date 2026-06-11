import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, Download, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/utils';
import { ImportContactsDialog } from '@/pages/contacts/ImportContactsDialog';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';

type Status = 'subscribed' | 'unsubscribed' | 'bounced' | 'complained' | 'pending';

interface ContactRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  subscriptionStatus: Status;
  createdAt: string;
}

const STATUS_LABEL: Record<Status, string> = {
  subscribed: '已订阅',
  unsubscribed: '已退订',
  bounced: '弹回',
  complained: '投诉',
  pending: '待确认',
};

const STATUS_VARIANT: Record<Status, 'success' | 'muted' | 'danger' | 'warning'> = {
  subscribed: 'success',
  unsubscribed: 'muted',
  bounced: 'danger',
  complained: 'danger',
  pending: 'warning',
};

export function ContactListDetailPage() {
  const { listId } = useParams<{ listId: string }>();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Status | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPage(1);
  }, [search, status, listId]);

  const detail = useQuery({
    queryKey: ['contact-list', listId],
    queryFn: async () => (await api.get(`/api/contact-lists/${listId}`)).data,
    enabled: !!listId,
  });

  const contacts = useQuery({
    queryKey: ['contacts', listId, search, status, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams({
        listId: listId!,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      return (await api.get(`/api/contacts?${params}`)).data as {
        items: ContactRow[];
        total: number;
      };
    },
    enabled: !!listId,
    // Keep prior rows visible only while paginating within the SAME
    // search+status filter — otherwise switching filter would briefly show
    // stale rows from the previous filter. A filter change shows a fresh load.
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey as unknown[] | undefined;
      return k && k[2] === search && k[3] === status ? prev : undefined;
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/contacts/${id}`),
    onError: (err) => toast(`删除失败:${apiErrMessage(err)}`, 'error'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['contacts', listId] }),
  });

  const items = contacts.data?.items ?? [];
  const visibleIds = useMemo(() => items.map((c) => c.id), [items]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => selectedIds.has(id));

  useEffect(() => {
    if (selectedIds.size === 0) return;
    const valid = new Set<string>();
    for (const id of selectedIds) if (visibleIds.includes(id)) valid.add(id);
    if (valid.size !== selectedIds.size) setSelectedIds(valid);
  }, [visibleIds, selectedIds]);

  const clearSelection = () => setSelectedIds(new Set());

  const batchMut = useMutation({
    mutationFn: (action: 'subscribe' | 'unsubscribe' | 'removeFromList') =>
      api.post('/api/contacts/batch', {
        action,
        ids: Array.from(selectedIds),
        listId: action === 'removeFromList' ? listId : undefined,
      }),
    onError: (err) => toast(`批量操作失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: () => {
      clearSelection();
      qc.invalidateQueries({ queryKey: ['contacts', listId] });
      qc.invalidateQueries({ queryKey: ['contact-list', listId] });
    },
  });

  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Download the full list as CSV. Always full list (ignores current
   *  search/status) to keep the affordance predictable; layout + columns
   *  mirror the import template so round-trips work. */
  async function handleExport() {
    if (!listId) return;
    setExporting(true);
    try {
      const r = await api.get(`/api/contact-lists/${listId}/export`, {
        responseType: 'blob',
      });
      const blob = new Blob([r.data], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      // Honour the server's `Content-Disposition: filename*=UTF-8''...`
      // when present so Chinese list names round-trip cleanly; fall back
      // to a date-stamped default.
      const filename =
        parseFilenameFromContentDisposition(
          r.headers['content-disposition'] as string | undefined,
        ) ?? `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(`导出失败:${apiErrMessage(err)}`, 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Button variant="outline" size="icon" asChild className="shrink-0">
        <Link to="/contacts" aria-label="返回列表">
          <ArrowLeft className="size-5" />
        </Link>
      </Button>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">{detail.data?.name ?? '...'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {formatNumber(detail.data?.contactsCount ?? 0)} 位联系人
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={exporting || (detail.data?.contactsCount ?? 0) === 0}
            className="w-full sm:w-auto"
            title={
              (detail.data?.contactsCount ?? 0) === 0 ? '该列表暂无联系人,无可导出内容' : undefined
            }
          >
            <Download className="mr-1 size-4" />
            {exporting ? '导出中…' : '导出 CSV'}
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowImport(true)}
            className="w-full sm:w-auto"
          >
            <Upload className="mr-1 size-4" />
            导入 CSV
          </Button>
          <Button onClick={() => setShowAdd((v) => !v)} className="w-full sm:w-auto">
            <Plus className="mr-1 size-4" />
            添加联系人
          </Button>
        </div>
      </div>

      {showAdd && (
        <AddContactInline
          listId={listId!}
          onDone={() => {
            setShowAdd(false);
            qc.invalidateQueries({ queryKey: ['contacts', listId] });
            qc.invalidateQueries({ queryKey: ['contact-list', listId] });
          }}
        />
      )}

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="按姓名 / 邮箱搜索"
                className="pl-8"
              />
            </div>
            <StatusFilter value={status} onChange={setStatus} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                {selectedIds.size > 0 ? (
                  <tr>
                    <th className="w-10 px-4 py-3">
                      <TriCheckbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        onChange={toggleAllVisible}
                        aria-label="全选当前页"
                      />
                    </th>
                    <th colSpan={4} className="px-2 py-2 normal-case tracking-normal">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          已选择 {selectedIds.size} 项
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={batchMut.isPending}
                          onClick={() => batchMut.mutate('subscribe')}
                        >
                          批量订阅
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={batchMut.isPending}
                          className="border-destructive/40 text-destructive hover:bg-destructive/10"
                          onClick={() => batchMut.mutate('unsubscribe')}
                        >
                          批量退订
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={batchMut.isPending}
                          className="border-destructive/40 text-destructive hover:bg-destructive/10"
                          onClick={async () => {
                            const ok = await confirm({
                              title: '从列表移除联系人',
                              description: `确定从当前列表移除 ${selectedIds.size} 位联系人吗?联系人本身不会被删除,仍可在其他列表中找到。`,
                              confirmLabel: '移除',
                              variant: 'danger',
                            });
                            if (ok) batchMut.mutate('removeFromList');
                          }}
                        >
                          移除
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={clearSelection}
                          aria-label="清空选择"
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    </th>
                  </tr>
                ) : (
                  <tr>
                    <th className="w-10 px-4 py-3">
                      <TriCheckbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        onChange={toggleAllVisible}
                        disabled={visibleIds.length === 0}
                        aria-label="全选当前页"
                      />
                    </th>
                    <th className="px-4 py-3 font-medium">邮箱</th>
                    <th className="px-4 py-3 font-medium">姓名</th>
                    <th className="px-4 py-3 font-medium">订阅状态</th>
                    <th className="px-4 py-3 font-medium">添加时间</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                )}
              </thead>
              <tbody>
                {contacts.isLoading && <TableSkeletonRows columns={6} />}
                {contacts.data?.items.length === 0 && <EmptyStateRow colSpan={6} />}
                {items.map((c) => {
                  const checked = selectedIds.has(c.id);
                  return (
                    <tr
                      key={c.id}
                      className={`border-b last:border-0 ${checked ? 'bg-[hsl(220,100%,98%)]' : ''}`}
                    >
                      <td className="w-10 px-4 py-3">
                        <TriCheckbox
                          checked={checked}
                          onChange={() => toggleOne(c.id)}
                          aria-label={`选择 ${c.email}`}
                        />
                      </td>
                      <td className="px-4 py-3 font-medium">{c.email}</td>
                      <td className="px-4 py-3">
                        {[c.firstName, c.lastName].filter(Boolean).join(' ') || '-'}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATUS_VARIANT[c.subscriptionStatus]}>
                          {STATUS_LABEL[c.subscriptionStatus]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDateTime(c.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          title="删除"
                          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
                          disabled={deleteMut.isPending}
                          onClick={async () => {
                            const ok = await confirm({
                              title: '删除联系人',
                              description: (
                                <>
                                  确定从所有列表中删除{' '}
                                  <span className="font-medium">{c.email}</span> 吗?该操作不可撤销。
                                </>
                              ),
                              confirmLabel: '删除',
                              variant: 'danger',
                            });
                            if (ok) deleteMut.mutate(c.id);
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
          {contacts.data && contacts.data.total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
              <span>共 {formatNumber(contacts.data.total)} 条</span>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={contacts.data.total}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {showImport && listId && (
        <ImportContactsDialog
          listId={listId}
          onClose={() => setShowImport(false)}
          onDone={() => {
            setShowImport(false);
            qc.invalidateQueries({ queryKey: ['contacts', listId] });
            qc.invalidateQueries({ queryKey: ['contact-list', listId] });
          }}
        />
      )}
    </div>
  );
}

const STATUS_FILTER_OPTIONS: Array<{ value: Status; label: string }> = [
  { value: 'pending', label: '未订阅' },
  { value: 'subscribed', label: '已订阅' },
  { value: 'unsubscribed', label: '已退订' },
];

function StatusFilter({
  value,
  onChange,
}: {
  value: Status | '';
  onChange: (v: Status | '') => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const current = STATUS_FILTER_OPTIONS.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-9 w-[140px] items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm transition-colors ${
          open ? 'border-primary ring-1 ring-primary/30' : 'border-input hover:border-primary/50'
        } ${current ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        <span>{current?.label ?? '订阅状态'}</span>
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-[140px] overflow-hidden rounded-md border bg-popover p-1 shadow-md">
          {STATUS_FILTER_OPTIONS.map((o) => {
            const selected = value === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(selected ? '' : o.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                  selected ? 'bg-accent text-accent-foreground' : ''
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TriCheckbox({
  checked,
  indeterminate,
  onChange,
  disabled,
  ...rest
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  disabled?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'checked' | 'type'>) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked;
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="size-4 cursor-pointer rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-50"
      {...rest}
    />
  );
}

/** Pull the filename out of an HTTP `Content-Disposition` header. Prefers
 *  the RFC 5987 `filename*=UTF-8''...` form (handles Chinese), falls back
 *  to the plain `filename="..."` field. Returns null if neither is present
 *  so the caller can pick a sane default. */
function parseFilenameFromContentDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // fall through to ASCII form
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

function AddContactInline({ listId, onDone }: { listId: string; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const mut = useMutation({
    mutationFn: () =>
      api.post('/api/contacts', {
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        listIds: [listId],
      }),
    onSuccess: () => {
      onDone();
      setEmail('');
      setFirstName('');
      setLastName('');
    },
  });
  return (
    <Card>
      <CardContent className="grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
        <div>
          <Label htmlFor="ce" className="text-xs">
            邮箱 *
          </Label>
          <Input id="ce" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cf" className="text-xs">
            名
          </Label>
          <Input id="cf" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cl" className="text-xs">
            姓
          </Label>
          <Input id="cl" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
        <div className="flex items-end">
          <Button
            className="w-full"
            disabled={!email.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? '添加中...' : '添加'}
          </Button>
        </div>
        {mut.isError && (
          <div className="md:col-span-4 text-sm text-destructive">{apiErrMessage(mut.error)}</div>
        )}
      </CardContent>
    </Card>
  );
}
