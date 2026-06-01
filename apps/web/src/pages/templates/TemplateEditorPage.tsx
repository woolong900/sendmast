import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Save } from 'lucide-react';
import { ConfigProvider } from '@arco-design/web-react';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import {
  EmailEditorProvider,
  EmailEditor,
  type IEmailTemplate,
} from 'easy-email-editor';
import { StandardLayout } from 'easy-email-extensions';
import {
  AdvancedType,
  BasicType,
  BlockManager,
  JsonToMjml,
  type IPage,
} from 'easy-email-core';
// Raw block ships only as a basic type (no AdvancedType.RAW); we still want
// it in the palette so users can drop in custom HTML / MJML snippets.
import mjml2html from 'mjml-browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { VariablesHelper } from '@/components/VariablesHelper';
import { api, apiErrMessage } from '@/lib/api';
import { easyEmailZhCN } from '@/lib/easy-email-locale';
import { uploadEditorImage } from '@/lib/easy-email-upload';
import { captureAndUploadThumbnail } from '@/lib/thumbnail';

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
  category: string | null;
  html: string;
  mjml: string | null;
  designJson: IEmailTemplate | null;
}

// Left-panel block palette. Mirrors easy-email's "Standard" recipe but in 中文.
const blockCategories = [
  {
    label: '基础组件',
    active: true,
    blocks: [
      { type: AdvancedType.TEXT },
      { type: AdvancedType.IMAGE },
      { type: AdvancedType.BUTTON },
      { type: AdvancedType.SOCIAL },
      { type: AdvancedType.DIVIDER },
      { type: AdvancedType.NAVBAR },
      { type: AdvancedType.CAROUSEL },
      { type: AdvancedType.ACCORDION },
      // WRAPPER / SECTION / COLUMN / GROUP are MJML structural primitives —
      // we omit them from the palette because users almost always want to
      // start from a content block or a column-layout preset. They remain
      // registered in BlockManager so the canvas can still render existing
      // designs and the "布局" presets below (which insert SECTION + COLUMNs
      // under the hood) keep working.
      // Raw block — escape-hatch for arbitrary HTML / MJML. Two shipped
      // defaults are bad for UX: (1) `<% if (user) { %>` is an EJS marker
      // that looks like a syntax error, (2) a bare <p> renders as a single
      // line of body text, so the dropped block is nearly invisible on the
      // canvas and easy to miss-click — leaving focusBlock null and the
      // right-side AttributePanel blank. Use a styled placeholder div so
      // the block is obviously selectable; users replace it on first edit.
      {
        type: BasicType.RAW,
        payload: {
          data: {
            value: {
              content:
                '<div style="padding:24px;border:2px dashed #d1d5db;background:#f9fafb;color:#6b7280;text-align:center;font-family:sans-serif;font-size:14px;line-height:1.6;">自定义代码块 — 选中后在右侧粘贴 HTML<br/><span style="font-size:12px;">(若只需文字段落，请改用「文本」块)</span></div>',
            },
          },
        },
      },
      // Footer-style unsubscribe text. `{{unsubscribe_url}}` is one of our
      // system tags (see packages/shared/src/schemas/system-tags.ts) — at
      // send time worker-sender substitutes it with the recipient-specific
      // /t/u/<token> URL. Users can double-click to edit the wording.
      {
        title: '底部退订',
        type: AdvancedType.TEXT,
        payload: {
          attributes: {
            color: '#9ca3af',
            'font-size': '12px',
            'line-height': '1.6',
            align: 'center',
            padding: '24px 25px',
          },
          data: {
            value: {
              content:
                'You received this email because you subscribed to our updates.<br/>Don\'t want to receive these anymore? <a href="{{unsubscribe_url}}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>',
            },
          },
        },
      },
    ],
  },
  {
    label: '布局',
    displayType: 'column' as const,
    blocks: [
      { title: '2 列等分', payload: [['50%', '50%']] },
      { title: '2 列 1:2', payload: [['33%', '67%']] },
      { title: '2 列 2:1', payload: [['67%', '33%']] },
      { title: '3 列等分', payload: [['33%', '33%', '33%']] },
      { title: '4 列等分', payload: [['25%', '25%', '25%', '25%']] },
    ],
  },
];

function emptyEmailTemplate(): IEmailTemplate {
  const page = BlockManager.getBlockByType(BasicType.PAGE)!.create({}) as IPage;
  return { content: page, subject: '', subTitle: '' };
}

export function TemplateEditorPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('未命名模板');
  const [category, setCategory] = useState('');
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
    if (detail.data.designJson?.content) return detail.data.designJson;
    return emptyEmailTemplate();
  }, [id, detail.data]);

  useEffect(() => {
    if (detail.data) {
      setName(detail.data.name);
      setCategory(detail.data.category ?? '');
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
        category: category || undefined,
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
              <div className="flex-1" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="模板名称"
                className="h-8 w-[220px]"
              />
              <Input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="分类（可选）"
                className="h-8 w-[180px]"
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
