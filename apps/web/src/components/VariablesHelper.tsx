import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Braces, Copy, X } from 'lucide-react';
import { SYSTEM_TAGS, type CustomTagView } from '@sendmast/shared';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

/**
 * Trigger button + modal listing the variables a user can drop into the
 * subject / preheader / body. The Easy Email canvas runs inside its own
 * managed React tree with no public cursor API for arbitrary text insertion,
 * so the modal focuses on copy-to-clipboard. Used in the campaign wizard
 * (next to subject/preheader inputs and in the editor toolbar) and in the
 * template editor toolbar.
 */
export function VariablesHelper({
  variant = 'link',
}: {
  variant?: 'link' | 'button';
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const customTags = useQuery<CustomTagView[]>({
    queryKey: ['custom-tags'],
    queryFn: async () => (await api.get('/api/custom-tags')).data,
    enabled: open,
    staleTime: 60_000,
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${text}`, 'success');
    } catch {
      toast('复制失败，请手动复制', 'error');
    }
  };

  const trigger =
    variant === 'button' ? (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Braces className="mr-1.5 size-4" />
        插入变量
      </Button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <Braces className="size-3.5" />
        插入变量
      </button>
    );

  return (
    <>
      {trigger}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-2xl overflow-hidden rounded-lg bg-background shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 className="text-base font-semibold">可用变量</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="-m-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="关闭"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="max-h-[70vh] space-y-5 overflow-y-auto p-5">
              <section>
                <div className="mb-2 text-sm font-semibold text-foreground">系统变量</div>
                <p className="mb-3 text-xs text-muted-foreground">
                  发送时由系统按收件人自动替换。点击占位符可复制。
                </p>
                <ul className="divide-y rounded-md border">
                  {SYSTEM_TAGS.map((t) => (
                    <li key={t.name} className="flex items-center gap-3 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => copy(t.placeholder)}
                        className="inline-flex shrink-0 items-center gap-1 rounded bg-purple-50 px-2 py-1 font-mono text-xs text-purple-700 hover:bg-purple-100"
                        title="点击复制"
                      >
                        {t.placeholder}
                        <Copy className="size-3" />
                      </button>
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="font-medium text-foreground">{t.label}</div>
                        <div className="text-muted-foreground">{t.description}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <div className="mb-2 flex items-baseline justify-between">
                  <div className="text-sm font-semibold text-foreground">
                    自定义变量
                    {customTags.data && customTags.data.length > 0 && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        ({customTags.data.length})
                      </span>
                    )}
                  </div>
                  <Link
                    to="/settings/custom-tags"
                    className="text-xs text-primary hover:underline"
                  >
                    管理自定义标签 →
                  </Link>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">
                  发送时从该标签的多个值中随机替换一个，每位收件人独立随机。
                </p>
                {customTags.isLoading ? (
                  <div className="rounded-md border px-3 py-4 text-center text-xs text-muted-foreground">
                    加载中…
                  </div>
                ) : !customTags.data || customTags.data.length === 0 ? (
                  <div className="rounded-md border">
                    <EmptyState compact />
                  </div>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {customTags.data.map((t) => {
                      const ph = `{{tag:${t.name}}}`;
                      return (
                        <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                          <button
                            type="button"
                            onClick={() => copy(ph)}
                            className="inline-flex shrink-0 items-center gap-1 rounded bg-purple-50 px-2 py-1 font-mono text-xs text-purple-700 hover:bg-purple-100"
                            title="点击复制"
                          >
                            {ph}
                            <Copy className="size-3" />
                          </button>
                          <div className="min-w-0 flex-1 text-xs">
                            <div className="font-medium uppercase tracking-wide text-foreground">
                              {t.name}
                            </div>
                            <div className="text-muted-foreground">
                              {t.values.length} 个候选值，发送时随机选一个
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
            <div className="flex justify-end border-t bg-muted/20 px-5 py-3">
              <Button variant="outline" onClick={() => setOpen(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
