import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Save, X } from 'lucide-react';
import { ConfigProvider } from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import {
  EmailEditorProvider,
  EmailEditor,
  type IEmailTemplate,
} from 'easy-email-editor';
import { StandardLayout } from 'easy-email-extensions';
import { JsonToMjml } from 'easy-email-core';
import mjml2html from 'mjml-browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VariablesHelper } from '@/components/VariablesHelper';
import { api, apiErrMessage } from '@/lib/api';
import { easyEmailZhCN } from '@/lib/easy-email-locale';
import { uploadEditorImage } from '@/lib/easy-email-upload';
import { captureAndUploadThumbnail } from '@/lib/thumbnail';
import { applyMergePreviewSamples } from '@/lib/email-merge-preview';
import {
  blockCategories,
  compilePreviewHtml,
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
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

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
      const mjml = JsonToMjml({
        data: values.content,
        mode: 'production',
        context: values.content,
      });
      const html = mjml2html(mjml).html;
      // Generate the preview thumbnail off the freshly compiled HTML and
      // ship the URL as part of the same save payload — see
      // apps/web/src/lib/thumbnail.ts for why this lives client-side.
      const thumbnail = await captureAndUploadThumbnail(html);
      const payload = {
        name,
        html,
        mjml,
        designJson: values,
        ...(thumbnail ? { thumbnail } : {}),
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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  // System templates are shared, read-only starting points — they can only be
  // previewed, not edited. (The API also rejects PATCH on system-scoped rows.)
  if (detail.data?.scope === 'system') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
          <Button variant="outline" size="sm" onClick={() => navigate('/templates')}>
            <ArrowLeft className="mr-1 size-4" />
            返回
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
        onSubmit={(values) => saveMut.mutate(values)}
      >
        {(_props, helper) => (
          // `fixed inset-0 z-50` lifts the editor out of Layout's
          // sidebar/topbar/centered-container chrome so the canvas owns the
          // full viewport. State stays mounted under Layout — only visual.
          <div className="fixed inset-0 z-50 flex flex-col bg-background">
            <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
              <Button variant="outline" size="sm" onClick={() => navigate('/templates')}>
                <ArrowLeft className="mr-1 size-4" />
                返回
              </Button>
              <VariablesHelper variant="button" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const values = helper.getState().values as IEmailTemplate;
                  setPreviewHtml(compilePreviewHtml(values));
                }}
              >
                <Eye className="mr-1 size-4" />
                预览
              </Button>
              <div className="flex-1" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="模板名称"
                className="h-8 w-[220px]"
              />
              <Button
                size="sm"
                disabled={saveMut.isPending}
                onClick={() => helper.submit()}
              >
                <Save className="mr-1 size-4" />
                {saveMut.isPending ? '保存中...' : '保存'}
              </Button>
            </div>
            {previewHtml && (
              <div
                className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
                onClick={() => setPreviewHtml(null)}
              >
                <div
                  className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-xl bg-card shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between border-b px-4 py-3">
                    <div>
                      <h3 className="text-sm font-semibold">邮件预览</h3>
                      <p className="text-xs text-muted-foreground">
                        商品列表与变量为示例数据，实际发送时由系统自动填充
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setPreviewHtml(null)}>
                      <X className="size-4" />
                    </Button>
                  </div>
                  <div className="overflow-auto bg-muted/30 p-4">
                    <iframe
                      title="template-preview"
                      srcDoc={previewHtml}
                      className="mx-auto min-h-[640px] w-full max-w-[640px] rounded-lg border bg-white shadow-sm"
                      sandbox=""
                    />
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
            <div className="flex-1 overflow-hidden">
              <StandardLayout categories={blockCategories} showSourceCode>
                <EmailEditor />
              </StandardLayout>
            </div>
          </div>
        )}
      </EmailEditorProvider>
    </ConfigProvider>
  );
}
