import {
  AdvancedType,
  BasicType,
  BlockManager,
  JsonToMjml,
  type IPage,
} from 'easy-email-core';
import { type IEmailTemplate } from 'easy-email-editor';
import mjml2html from 'mjml-browser';
import { applyMergePreviewSamples } from '@/lib/email-merge-preview';
import '@/lib/easy-email-raw-block-fix';

/**
 * Shared Easy Email editor building blocks, used by both the template editor and
 * the automation email editor. Kept in one place so the block palette + compile
 * pipeline never diverge between the two entry points.
 */

// Left-panel block palette. Mirrors easy-email's "Standard" recipe but in 中文.
export const blockCategories = [
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
      // Raw block — escape-hatch for arbitrary HTML / MJML. Styled placeholder
      // so the dropped block is obviously selectable; users replace it on edit.
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
      {
        title: '商品列表',
        type: BasicType.RAW,
        payload: {
          data: {
            value: {
              content: '{{order_items}}',
            },
          },
        },
      },
      // Footer-style unsubscribe text. `{{unsubscribe_url}}` is a system tag —
      // worker-sender substitutes it with the recipient-specific /t/u/<token>.
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

export function emptyEmailTemplate(): IEmailTemplate {
  const page = BlockManager.getBlockByType(BasicType.PAGE)!.create({}) as IPage;
  return { content: page, subject: '', subTitle: '' };
}

/**
 * Wrap raw HTML (a design with no `designJson`) in a single RAW block page so
 * the block editor can still open + edit it. Rarely needed — our seeded flows
 * carry designJson — but keeps the editor from opening blank on legacy content.
 */
export function htmlToEmailTemplate(html: string): IEmailTemplate {
  const page = BlockManager.getBlockByType(BasicType.PAGE)!.create({}) as IPage;
  const raw = BlockManager.getBlockByType(BasicType.RAW)!.create({
    data: { value: { content: html } },
  });
  page.children.push(raw);
  return { content: page, subject: '', subTitle: '' };
}

export function compileTemplate(values: IEmailTemplate): { html: string; mjml: string } {
  const mjml = JsonToMjml({
    data: values.content,
    mode: 'production',
    context: values.content,
  });
  return { html: mjml2html(mjml).html, mjml };
}

export function compileTemplateHtml(values: IEmailTemplate): string {
  return compileTemplate(values).html;
}

export function compilePreviewHtml(values: IEmailTemplate): string {
  return applyMergePreviewSamples(compileTemplateHtml(values));
}

export function compileThumbnailHtml(values: IEmailTemplate): string {
  const mjml = JsonToMjml({
    data: values.content,
    mode: 'testing',
    context: values.content,
    idx: 'content',
  });
  return applyMergePreviewSamples(mjml2html(mjml).html);
}
