import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Save } from 'lucide-react';
import { ConfigProvider } from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import {
  EmailEditorProvider,
  EmailEditor,
  type IEmailTemplate,
} from 'easy-email-editor';
import { StandardLayout } from 'easy-email-extensions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FullscreenEmailEditor } from '@/components/FullscreenEmailEditor';
import { api, apiErrMessage } from '@/lib/api';
import { easyEmailZhCN } from '@/lib/easy-email-locale';
import { uploadEditorImage } from '@/lib/easy-email-upload';
import { captureAndUploadThumbnail } from '@/lib/thumbnail';
import { applyMergePreviewSamples } from '@/lib/email-merge-preview';
import {
  blockCategories,
  compileTemplate,
  compileThumbnailHtml,
  emptyEmailTemplate,
} from '@/lib/easy-email-editor-shared';

import 'easy-email-editor/lib/style.css';
import 'easy-email-extensions/lib/style.css';
import '@arco-design/web-react/dist/css/arco.css';
// Override easy-email-core's default vercel-demo asset URLs (now 404).
// MUST stay below the easy-email-* imports above so this side-effect runs
// AFTER core's own `ImageManager.add(defaultImagesMap)` initializer.
import '@/lib/easy-email-image-overrides';
import '@/lib/easy-email-raw-block-fix';

interface TemplateView {
  id: string;
  name: string;
  scope: 'system' | 'user';
  html: string;
  mjml: string | null;
  designJson: IEmailTemplate | null;
}

export function TemplateEditorPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('未命名模板');
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery<TemplateView>({
    queryKey: ['templates', id],
    queryFn: async () => (await api.get(`/api/templates/${id}`)).data,
    enabled: !!id,
  });

  // detail.data may be undefined briefly (loading) or have a null designJson
  // (legacy Unlayer template — we wiped those in the rebrand migration).
  // Either way we mount the editor with an empty IEmailTemplate; saving will
  // silently overwrite the old HTML with whatever the user composes on the
  // blank canvas.
  const initialData = useMemo<IEmailTemplate | null>(() => {
    if (!id) return emptyEmailTemplate();
    if (!detail.data) return null;
    if (detail.data.designJson?.content) {
      return detail.data.designJson;
    }
    return emptyEmailTemplate();
  }, [id, detail.data]);

  useEffect(() => {
    if (detail.data) {
      setName(detail.data.name);
    }
  }, [detail.data]);

  const saveMut = useMutation({
    mutationFn: async (values: IEmailTemplate) => {
      const { html, mjml } = compileTemplate(values);
      // Generate the preview thumbnail off the freshly compiled HTML and
      // ship the URL as part of the same save payload — see
      // apps/web/src/lib/thumbnail.ts for why this lives client-side.
      const thumbnail = await captureAndUploadThumbnail(compileThumbnailHtml(values));
      const payload = {
        name,
        html,
        mjml,
        designJson: values,
        thumbnail,
      };
      if (id) return api.patch(`/api/templates/${id}`, payload);
      return api.post('/api/templates', payload);
    },
    onSuccess: (r) => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['templates'] });
      if (id) void qc.invalidateQueries({ queryKey: ['templates', id] });
      if (!id) navigate(`/templates/${r.data.id}/edit`, { replace: true });
    },
    onError: (e) => setError(apiErrMessage(e)),
  });

  if (!initialData) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        <div className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-56" />
          <Skeleton className="ml-auto h-9 w-20" />
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="hidden w-64 space-y-4 border-r p-4 md:block">
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
          <div className="flex flex-1 justify-center bg-muted/30 p-6">
            <Skeleton className="h-full w-full max-w-3xl rounded-none bg-background" />
          </div>
        </div>
      </div>
    );
  }

  // System templates are shared, read-only starting points — they can only be
  // previewed, not edited. (The API also rejects PATCH on system-scoped rows.)
  if (detail.data?.scope === 'system') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
          <Button variant="outline" onClick={() => navigate('/templates')}>
            <LogOut className="mr-1.5 size-4" />
            退出编辑
          </Button>
          <div className="truncate text-sm font-medium">{detail.data.name}</div>
          <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            系统模板 · 仅预览
          </span>
        </div>
        <div className="flex-1 overflow-hidden bg-muted/30 p-4">
          <iframe
            title="template-preview"
            srcDoc={applyMergePreviewSamples(detail.data.html)}
            className="mx-auto block h-full w-full max-w-[640px] rounded-lg border bg-white shadow-sm"
            sandbox=""
          />
        </div>
      </div>
    );
  }

  return (
    <ConfigProvider locale={zhCN}>
      <EmailEditorProvider
        key={id ?? 'new'}
        data={initialData}
        // Fullscreen overlay: viewport height minus our own 49px header bar
        // (no Layout topbar to subtract since `fixed inset-0` escapes Layout).
        height="calc(100vh - 49px)"
        autoComplete
        dashed={false}
        locale={easyEmailZhCN}
        onUploadImage={uploadEditorImage}
        onSubmit={() => {
          // Saves are driven from the toolbar via helper.getState().values so
          // thumbnails are generated from the latest editor state.
        }}
      >
        {(_props, helper) => (
          <FullscreenEmailEditor
            onExit={() => navigate('/templates')}
            toolbar={
              <div className="ml-auto flex items-center gap-3">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="模板名称"
                  className="w-[220px]"
                />
                <Button
                  disabled={saveMut.isPending}
                  onClick={() => {
                    saveMut.mutate(helper.getState().values as IEmailTemplate);
                  }}
                >
                  <Save className="mr-1.5 size-4" />
                  {saveMut.isPending ? '保存中...' : '保存'}
                </Button>
              </div>
            }
            banner={
              error ? (
                <div className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
                  {error}
                </div>
              ) : null
            }
          >
            <div className="flex-1 overflow-hidden">
              <StandardLayout categories={blockCategories} showSourceCode>
                <EmailEditor />
              </StandardLayout>
            </div>
          </FullscreenEmailEditor>
        )}
      </EmailEditorProvider>
    </ConfigProvider>
  );
}
