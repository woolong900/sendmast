// One-off generator: rebuild the abandoned-cart system template with the
// order-number / order-total summary block removed (and the divider that only
// existed to separate it). Reuses the current template source from the latest
// migration, removes that one block, and re-renders HTML via mjml so the rest
// stays byte-identical.
//
//   node scripts/gen-abandoned-template.mjs
//
// Emits:
//   packages/db/prisma/migrations/20260610210000_abandoned_cart_remove_order_summary/migration.sql
//   packages/db/src/abandoned-cart-template.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const require = createRequire(resolve(repo, 'apps/api/package.json'));
const mjml2html = require('mjml');

const ID = '00000000-0000-4000-8000-000000000004';
const NAME = '弃单召回（默认）';

// The divider + order/total summary block to strip (matches the MJML verbatim).
const BLOCK_OLD =
  '<mj-divider align="center" border-width="1px" border-style="solid" border-color="#eceff3" padding="8px 0 16px" ></mj-divider><mj-text padding="0 0 24px" align="left" font-size="14px" color="#111827" line-height="1.8" ><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0;border-collapse:collapse;background:#f9fafb;border:1px solid #eceff3;border-radius:8px;"><tr><td style="padding:14px 18px;font-size:14px;color:#6b7280;">Order</td><td align="right" style="padding:14px 18px;font-size:14px;color:#111827;font-weight:600;">{{order_no}}</td></tr><tr><td style="padding:0 18px 14px;font-size:14px;color:#6b7280;border-top:1px solid #eceff3;">Total</td><td align="right" style="padding:14px 18px;font-size:18px;color:#111827;font-weight:700;border-top:1px solid #eceff3;">{{order_total}}</td></tr></table></mj-text>';

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
  'packages/db/prisma/migrations/20260610120000_abandoned_cart_english_shop_name/migration.sql',
);
const sql = readFileSync(src, 'utf8');
const mjml = extractBlock(sql, '$mjml$');
const design = JSON.parse(extractBlock(sql, '$json$'));

if (!mjml.includes(BLOCK_OLD)) throw new Error('order-summary block not found in mjml');
const newMjml = mjml.replace(BLOCK_OLD, '');
const { html, errors } = mjml2html(newMjml, { validationLevel: 'soft' });
if (errors && errors.length) console.warn(`${errors.length} mjml warnings`);

// Drop the advanced_divider and the order/total advanced_text from design json.
let removed = 0;
const card = design.content.children[1].children[0];
card.children = card.children.filter((n) => {
  const content = n?.data?.value?.content ?? '';
  const isSummary = typeof content === 'string' && content.includes('{{order_no}}');
  const isDivider = n?.type === 'advanced_divider';
  if (isSummary || isDivider) {
    removed++;
    return false;
  }
  return true;
});
if (removed !== 2) throw new Error(`expected to drop 2 nodes, dropped ${removed}`);

// ---- migration ----
const migration = `-- Abandoned cart: drop the order-number / order-total summary block (and the
-- divider above it). The recall email keeps the product list + CTA only.
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
  'packages/db/prisma/migrations/20260610210000_abandoned_cart_remove_order_summary',
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

console.log('wrote migration + abandoned-cart-template.ts');
console.log(
  'html bytes:',
  html.length,
  'has {{order_items}}:',
  html.includes('{{order_items}}'),
  'has {{tracking_url}}:',
  html.includes('{{tracking_url}}'),
  'has {{order_no}}:',
  html.includes('{{order_no}}'),
  'has {{order_total}}:',
  html.includes('{{order_total}}'),
);
