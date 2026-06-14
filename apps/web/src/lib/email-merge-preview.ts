/**
 * Sample cart line-item HTML — mirrors worker-shop-sync's renderOrderItemsHtml
 * layout so the "预览" modal shows a realistic product list. Never stored in
 * the DB and never injected into the editing canvas — used only to render the
 * preview HTML so the user can see how the merge tags will look when sent.
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

/** Preview values for automation merge tags (preview modal only). */
export const MERGE_PREVIEW_SAMPLES: Record<string, string> = {
  shop_name: 'My Store',
  full_name: 'Jane Doe',
  order_no: 'SM-10042',
  order_total: 'US$89.00',
  order_currency: 'USD',
  tracking_url: '#',
  unsubscribe_url: '#',
  order_items: SAMPLE_ORDER_ITEMS_HTML,
  shipping_address: 'Jane Doe<br>123 Market Street<br>San Francisco, CA 94105<br>United States',
  billing_address: 'Jane Doe<br>123 Market Street<br>San Francisco, CA 94105<br>United States',
};

const ORDER_ITEMS_TAG = '{{order_items}}';

/** Replace `{{tag}}` placeholders in compiled HTML/text with sample values. */
export function applyMergePreviewSamples(source: string): string {
  let out = source;
  // HTML fragment first (longest / most specific).
  out = out.split(ORDER_ITEMS_TAG).join(SAMPLE_ORDER_ITEMS_HTML);
  for (const [name, sample] of Object.entries(MERGE_PREVIEW_SAMPLES)) {
    if (name === 'order_items') continue;
    out = out.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g'), sample);
  }
  return out;
}
