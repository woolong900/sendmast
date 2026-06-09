import type { IEmailTemplate } from 'easy-email-editor';

/**
 * Sample cart line-item HTML — mirrors worker-shop-sync's renderOrderItemsHtml
 * layout so the template editor shows a realistic product list. Never stored
 * in the DB; swapped in only for canvas/preview and restored to
 * `{{order_items}}` on save.
 */
export const SAMPLE_ORDER_ITEMS_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse; margin:0 0 24px;">
              <tr>
                <td width="72" valign="top" style="padding:14px 0;border-top:1px solid #eceff3;"><img src="https://placehold.co/112x112/f1f3f5/9ca3af/png?text=+" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:8px;border:1px solid #eceff3;object-fit:cover;"></td>
                <td valign="middle" style="padding:14px 0 14px 14px;border-top:1px solid #eceff3;font-size:16px;color:#111827;line-height:1.4;"><strong style="font-weight:600;">Classic Cotton Tee</strong> &times; 1<div style="font-size:13px;color:#9ca3af;margin-top:3px;">Size M / Black</div></td>
              </tr>
              <tr>
                <td width="72" valign="top" style="padding:14px 0;border-top:1px solid #eceff3;"><img src="https://placehold.co/112x112/f1f3f5/9ca3af/png?text=+" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:8px;border:1px solid #eceff3;object-fit:cover;"></td>
                <td valign="middle" style="padding:14px 0 14px 14px;border-top:1px solid #eceff3;font-size:16px;color:#111827;line-height:1.4;"><strong style="font-weight:600;">Everyday Canvas Tote</strong> &times; 2</td>
              </tr>
            </table>`;

/** Preview values for automation merge tags (editor / preview only). */
export const MERGE_PREVIEW_SAMPLES: Record<string, string> = {
  shop_name: 'Acme Store',
  full_name: 'Jane Doe',
  order_no: 'SM-10042',
  order_total: 'US$89.00',
  order_currency: 'USD',
  tracking_url: '#',
  unsubscribe_url: '#',
  order_items: SAMPLE_ORDER_ITEMS_HTML,
};

const ORDER_ITEMS_TAG = '{{order_items}}';

type BlockNode = {
  type?: string;
  data?: { value?: { content?: string } };
  attributes?: Record<string, string>;
  children?: BlockNode[];
};

function walkBlocks(node: BlockNode, visit: (block: BlockNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkBlocks(child, visit);
}

/** Inject sample merge values into designJson for canvas editing. */
export function applyDesignJsonMergePreviews(template: IEmailTemplate): IEmailTemplate {
  const cloned = structuredClone(template) as IEmailTemplate;
  if (!cloned.content) return cloned;

  walkBlocks(cloned.content as BlockNode, (block) => {
    if (block.type === 'raw') return;

    const content = block.data?.value?.content;
    if (typeof content === 'string' && content.includes('{{')) {
      block.data!.value!.content = applyMergePreviewSamples(content);
    }

    const href = block.attributes?.href;
    if (typeof href === 'string' && href.startsWith('{{') && href.endsWith('}}')) {
      block.attributes!.href = '#';
    }
  });

  return cloned;
}

/** Restore merge-tag placeholders before persisting designJson. */
export function stripDesignJsonMergePreviews(template: IEmailTemplate): IEmailTemplate {
  const cloned = structuredClone(template) as IEmailTemplate;
  if (!cloned.content) return cloned;

  walkBlocks(cloned.content as BlockNode, (block) => {
    if (block.type === 'raw') {
      const content = block.data?.value?.content ?? '';
      if (content.includes(SAMPLE_ORDER_ITEMS_HTML) || content.trim() === SAMPLE_ORDER_ITEMS_HTML.trim()) {
        block.data!.value!.content = ORDER_ITEMS_TAG;
      } else if (content.trim() === ORDER_ITEMS_TAG) {
        block.data!.value!.content = ORDER_ITEMS_TAG;
      }
      return;
    }

    const content = block.data?.value?.content;
    if (typeof content === 'string') {
      block.data!.value!.content = stripMergePreviewSamples(content);
    }

    if (block.type === 'advanced_button' && block.attributes?.href === '#') {
      block.attributes.href = '{{tracking_url}}';
    }
  });

  return cloned;
}

/** Replace `{{tag}}` placeholders in compiled HTML/text with sample values. */
export function applyMergePreviewSamples(source: string): string {
  let out = source;
  // HTML fragment first (longest / most specific).
  out = out.split(ORDER_ITEMS_TAG).join(SAMPLE_ORDER_ITEMS_HTML);
  for (const [name, sample] of Object.entries(MERGE_PREVIEW_SAMPLES)) {
    if (name === 'order_items') continue;
    out = out.split(`{{${name}}}`).join(sample);
  }
  return out;
}

/** Reverse {@link applyMergePreviewSamples} for save-safe HTML/text. */
export function stripMergePreviewSamples(source: string): string {
  let out = source;
  out = out.split(SAMPLE_ORDER_ITEMS_HTML).join(ORDER_ITEMS_TAG);
  // Longest samples first to avoid partial replacements.
  const entries = Object.entries(MERGE_PREVIEW_SAMPLES)
    .filter(([name]) => name !== 'order_items')
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, sample] of entries) {
    out = out.split(sample).join(`{{${name}}}`);
  }
  return out;
}
