import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Eye, LayoutTemplate, Save, X } from 'lucide-react';
import { ConfigProvider } from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import {
  EmailEditorProvider,
  EmailEditor,
  type IEmailTemplate,
} from 'easy-email-editor';
import { StandardLayout } from 'easy-email-extensions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FullscreenEmailEditor } from '@/components/FullscreenEmailEditor';
import { api } from '@/lib/api';
import { easyEmailZhCN } from '@/lib/easy-email-locale';
import { uploadEditorImage } from '@/lib/easy-email-upload';
import { captureAndUploadThumbnail } from '@/lib/thumbnail';
import {
  blockCategories,
  compilePreviewHtml,
  compileTemplate,
  emptyEmailTemplate,
  htmlToEmailTemplate,
} from '@/lib/easy-email-editor-shared';

import 'easy-email-editor/lib/style.css';
import 'easy-email-extensions/lib/style.css';
import '@arco-design/web-react/dist/css/arco.css';
import '@/lib/easy-email-image-overrides';
import '@/lib/easy-email-raw-block-fix';

/** Content produced when the user saves the editor. */
export interface AutomationEmailContent {
  html: string;
  mjml: string;
  designJson: IEmailTemplate;
  thumbnail: string | null;
}

interface EditorTemplate {
  id: string;
  name: string;
  scope: 'system' | 'user';
  html: string;
  designJson: IEmailTemplate | null;
  thumbnail: string | null;
}

/** Build the editor's starting block tree from stored content. */
function toEditorData(designJson: IEmailTemplate | null, html: string | null): IEmailTemplate {
  if (designJson?.content) return designJson;
  if (html) return htmlToEmailTemplate(html);
  return emptyEmailTemplate();
}

/**
 * Fullscreen Easy Email editor for an automation flow / recovery round. Edits
 * the email content in place; the user can also pull in another template's
 * design as a starting point. On save it compiles to html/mjml + a thumbnail and
 * hands the content back to the caller (which persists it on page save).
 */
export function AutomationEmailEditor({
  initialDesignJson,
  initialHtml,
  onClose,
  onApply,
}: {
  initialDesignJson: IEmailTemplate | null;
  initialHtml: string | null;
  onClose: () => void;
  onApply: (content: AutomationEmailContent) => void;
}) {
  const [data, setData] = useState<IEmailTemplate>(() =>
    toEditorData(initialDesignJson, initialHtml),
  );
  // Remount the provider when we swap in a different template's design.
  const [editorKey, setEditorKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const templates = useQuery<EditorTemplate[]>({
    queryKey: ['templates'],
    queryFn: async () => (await api.get('/api/templates')).data,
    enabled: pickerOpen,
  });

  const pickTemplate = (t: EditorTemplate) => {
    setData(toEditorData(t.designJson, t.html));
    setEditorKey((k) => k + 1);
    setPickerOpen(false);
  };

  return (
    <ConfigProvider locale={zhCN}>
      <EmailEditorProvider
        key={editorKey}
        data={data}
        height="calc(100vh - 49px)"
        autoComplete
        dashed={false}
        locale={easyEmailZhCN}
        onUploadImage={uploadEditorImage}
        onSubmit={async (values) => {
          setSaving(true);
          try {
            const { html, mjml } = compileTemplate(values as IEmailTemplate);
            const thumbnail = (await captureAndUploadThumbnail(html)) ?? null;
            onApply({ html, mjml, designJson: values as IEmailTemplate, thumbnail });
            onClose();
          } finally {
            setSaving(false);
          }
        }}
      >
        {(_props, helper) =>
          createPortal(
          <FullscreenEmailEditor
            onExit={onClose}
            toolbar={
              <div className="ml-auto flex items-center gap-3">
                <Button variant="outline" onClick={() => setPickerOpen(true)}>
                  <LayoutTemplate className="mr-1.5 size-4" />
                  选择模板
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    const values = helper.getState().values as IEmailTemplate;
                    setPreviewHtml(compilePreviewHtml(values));
                  }}
                >
                  <Eye className="mr-1.5 size-4" />
                  预览
                </Button>
                <Button disabled={saving} onClick={() => helper.submit()}>
                  <Save className="mr-1.5 size-4" />
                  {saving ? '保存中...' : '保存'}
                </Button>
              </div>
            }
          >
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
                      title="automation-email-preview"
                      srcDoc={previewHtml}
                      className="mx-auto min-h-[640px] w-full max-w-[640px] rounded-lg border bg-white shadow-sm"
                      sandbox=""
                    />
                  </div>
                </div>
              </div>
            )}

            {pickerOpen && (
              <div
                className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
                onClick={() => setPickerOpen(false)}
              >
                <div
                  className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-card shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between border-b px-5 py-4">
                    <div>
                      <h2 className="text-base font-semibold">选择模板</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        用所选模板的设计替换当前内容（仍可继续编辑）
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPickerOpen(false)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted/40"
                      aria-label="关闭"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  <div className="overflow-auto p-5">
                    {templates.isLoading ? (
                      <div className="py-12 text-center text-sm text-muted-foreground">
                        加载模板…
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {(templates.data ?? []).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => pickTemplate(t)}
                            className="flex flex-col overflow-hidden rounded-md border text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
                          >
                            <div className="aspect-[4/3] overflow-hidden bg-muted/40">
                              {t.thumbnail ? (
                                <img
                                  src={t.thumbnail}
                                  alt=""
                                  className="h-full w-full object-cover object-top"
                                />
                              ) : (
                                <iframe
                                  title={`tpl-${t.id}`}
                                  srcDoc={t.html}
                                  sandbox=""
                                  scrolling="no"
                                  className="pointer-events-none h-[300%] w-[300%] origin-top-left scale-[0.333] border-0 bg-white"
                                />
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-2 px-3 py-2">
                              <span className="truncate text-sm font-medium">{t.name}</span>
                              <Badge variant={t.scope === 'system' ? 'muted' : 'default'}>
                                {t.scope === 'system' ? '系统' : '我的'}
                              </Badge>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-hidden">
              <StandardLayout categories={blockCategories} showSourceCode>
                <EmailEditor />
              </StandardLayout>
            </div>
          </FullscreenEmailEditor>,
          document.body,
          )
        }
      </EmailEditorProvider>
    </ConfigProvider>
  );
}
