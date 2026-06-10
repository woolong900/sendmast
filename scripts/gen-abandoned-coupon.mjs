// One-off generator: add the {{coupon_block}} slot to the abandoned-cart
// template (right above the CTA button) and re-render HTML. The block is a
// system-rendered HTML fragment that's empty when the round has no coupon, so
// shipping this is safe before the coupon-selection feature exists.
//
//   node scripts/gen-abandoned-coupon.mjs
//
// Emits:
//   packages/db/prisma/migrations/20260610240000_abandoned_cart_coupon_block/migration.sql
//   packages/db/src/abandoned-cart-template.ts
//   /tmp/abandoned-coupon-preview.html   (sample-filled, for visual review)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const require = createRequire(resolve(repo, 'apps/api/package.json'));
const mjml2html = require('mjml');

const ID = '00000000-0000-4000-8000-000000000004';

/** The coupon card — system renders this fragment into {{coupon_block}}. */
export function couponBlockHtml(code, title) {
  const t = title || 'A discount just for you';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0;border-collapse:collapse;margin:0;">
  <tr><td align="center" style="padding:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-spacing:0;border-collapse:separate;background:#fff7ed;border:2px dashed #f59e0b;border-radius:12px;">
      <tr><td align="center" style="padding:22px 24px;">
        <div style="font-size:14px;color:#92400e;font-weight:600;margin:0 0 12px;">${t}</div>
        <div style="display:inline-block;background:#ffffff;border:1px dashed #f59e0b;border-radius:8px;padding:11px 24px;font-size:24px;font-weight:700;letter-spacing:3px;color:#111827;font-family:'Courier New',Courier,monospace;">${code}</div>
        <div style="font-size:12px;color:#b45309;margin:12px 0 0;">Apply this code at checkout</div>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

function extractBlock(sql, marker) {
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error(`block ${marker} not found`);
  const inner = start + marker.length;
  const end = sql.indexOf(marker, inner);
  if (end < 0) throw new Error(`block ${marker} not closed`);
  return sql.slice(inner, end);
}

const src = resolve(
  repo,
  'packages/db/prisma/migrations/20260610210000_abandoned_cart_remove_order_summary/migration.sql',
);
const sql = readFileSync(src, 'utf8');
const mjml = extractBlock(sql, '$mjml$');
const design = JSON.parse(extractBlock(sql, '$json$'));

// Insert the coupon raw right after the order-items raw (i.e. just above CTA).
const ITEMS_RAW = '<mj-raw >{{order_items}}</mj-raw>';
if (!mjml.includes(ITEMS_RAW)) throw new Error('order_items raw not found in mjml');
if (mjml.includes('{{coupon_block}}')) throw new Error('coupon_block already present');
const newMjml = mjml.replace(ITEMS_RAW, `${ITEMS_RAW}<mj-raw >{{coupon_block}}</mj-raw>`);
const { html, errors } = mjml2html(newMjml, { validationLevel: 'soft' });
if (errors && errors.length) console.warn(`${errors.length} mjml warnings`);

// Mirror into design json: add a raw child after the {{order_items}} raw.
const card = design.content.children[1].children[0];
const itemsIdx = card.children.findIndex((n) => n?.data?.value?.content === '{{order_items}}');
if (itemsIdx < 0) throw new Error('order_items raw node not found in design json');
card.children.splice(itemsIdx + 1, 0, {
  type: 'raw',
  data: { value: { content: '{{coupon_block}}' } },
  attributes: {},
  children: [],
});

// ---- migration ----
const migration = `-- Abandoned cart: add the {{coupon_block}} slot above the CTA. System renders
-- the coupon card into it per round; empty (hidden) when no coupon is chosen.
UPDATE "email_templates"
SET
  "mjml" = $mjml$${newMjml}$mjml$,
  "html" = $html$${html}$html$,
  "design_json" = $json$${JSON.stringify(design)}$json$::jsonb,
  "updated_at" = now()
WHERE "id" = '${ID}';
`;
const migDir = resolve(
  repo,
  'packages/db/prisma/migrations/20260610240000_abandoned_cart_coupon_block',
);
mkdirSync(migDir, { recursive: true });
writeFileSync(resolve(migDir, 'migration.sql'), migration);

// ---- ts builder ----
const ts = `/** System default abandoned-cart template — block-based easy-email designJson. */
export const ABANDONED_CART_TEMPLATE_ID = '${ID}';
export const ABANDONED_CART_SUBJECT = ${JSON.stringify(design.subject)};

export const abandonedCartDesignJson = ${JSON.stringify(design, null, 2)} as const;

export const abandonedCartMjml = ${JSON.stringify(newMjml)};

export const abandonedCartHtml = ${JSON.stringify(html)};
`;
writeFileSync(resolve(repo, 'packages/db/src/abandoned-cart-template.ts'), ts);

// ---- preview (sample-filled) ----
const sampleItems = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse; margin:0 0 24px;">
  <tr>
    <td width="72" valign="top" style="padding:14px 0;border-top:1px solid #eceff3;"><div style="width:56px;height:56px;border-radius:8px;border:1px solid #eceff3;background:#f1f3f5;"></div></td>
    <td valign="middle" style="padding:14px 0 14px 14px;border-top:1px solid #eceff3;font-size:16px;color:#111827;line-height:1.4;"><strong style="font-weight:600;">Wireless Earbuds Pro</strong> &times; 1</td>
  </tr>
  <tr>
    <td width="72" valign="top" style="padding:14px 0;border-top:1px solid #eceff3;"><div style="width:56px;height:56px;border-radius:8px;border:1px solid #eceff3;background:#f1f3f5;"></div></td>
    <td valign="middle" style="padding:14px 0 14px 14px;border-top:1px solid #eceff3;font-size:16px;color:#111827;line-height:1.4;"><strong style="font-weight:600;">Charging Case</strong> &times; 2</td>
  </tr>
</table>`;
const preview = html
  .replaceAll('{{shop_name}}', 'Acme Store')
  .replaceAll('{{full_name}}', 'Alex')
  .replaceAll('{{order_items}}', sampleItems)
  .replaceAll('{{coupon_block}}', couponBlockHtml('SAVE15', "Here's 15% off to finish your order"))
  .replaceAll('{{tracking_url}}', '#')
  .replaceAll('{{unsubscribe_url}}', '#');
writeFileSync('/tmp/abandoned-coupon-preview.html', preview);

console.log('wrote migration + ts + /tmp/abandoned-coupon-preview.html');
console.log('html has {{coupon_block}}:', html.includes('{{coupon_block}}'));
