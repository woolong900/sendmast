// One-off generator: rebuild the order-confirmation + order-shipped system
// templates with the order number moved under the shop name (single left
// column). Reuses the current template source from the latest migrations,
// swaps only the header, and re-renders HTML via mjml so the rest stays intact.
//
//   node scripts/gen-order-templates.mjs
//
// Emits:
//   packages/db/prisma/migrations/20260610190000_order_no_left/migration.sql
//   packages/db/src/order-confirmation-template.ts
//   packages/db/src/order-shipped-template.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const require = createRequire(resolve(repo, 'apps/api/package.json'));
const mjml2html = require('mjml');

const HEADER_OLD =
  '<mj-section padding="40px 0 16px" border="none" direction="ltr" text-align="center" background-repeat="repeat" background-size="auto" background-position="top center" background-color="#f4f4f5" ><mj-column padding="0px" border="none" vertical-align="middle" width="60%" ><mj-text padding="0 20px" align="left" font-size="26px" color="#111827" >{{shop_name}}</mj-text></mj-column><mj-column padding="0px" border="none" vertical-align="middle" width="40%" ><mj-text padding="0 20px" align="right" font-size="14px" color="#9ca3af" font-weight="600" >ORDER #{{order_no}}</mj-text></mj-column></mj-section>';
const HEADER_NEW =
  '<mj-section padding="40px 0 16px" border="none" direction="ltr" text-align="center" background-repeat="repeat" background-size="auto" background-position="top center" background-color="#f4f4f5" ><mj-column padding="0px" border="none" vertical-align="middle" width="100%" ><mj-text padding="0 20px" align="left" font-size="26px" color="#111827" >{{shop_name}}</mj-text><mj-text padding="6px 20px 0" align="left" font-size="14px" color="#9ca3af" font-weight="600" >ORDER #{{order_no}}</mj-text></mj-column></mj-section>';

function extractBlock(sql, marker) {
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error(`block ${marker} not found`);
  const inner = start + marker.length;
  const end = sql.indexOf(marker, inner);
  if (end < 0) throw new Error(`block ${marker} not closed`);
  return sql.slice(inner, end);
}

/** Move order_no into the shop-name column (single full-width column). */
function rewriteHeaderJson(design) {
  const header = design.content.children[0];
  const [col60, col40] = header.children;
  const shopText = col60.children[0];
  const orderText = col40.children[0];
  orderText.attributes = { ...orderText.attributes, padding: '6px 20px 0', align: 'left' };
  header.children = [
    {
      type: 'column',
      data: { value: {} },
      attributes: { padding: '0px', border: 'none', 'vertical-align': 'middle', width: '100%' },
      children: [shopText, orderText],
    },
  ];
  return design;
}

function build(srcMigration) {
  const sql = readFileSync(srcMigration, 'utf8');
  const mjml = extractBlock(sql, '$mjml$');
  const json = JSON.parse(extractBlock(sql, '$json$'));
  if (!mjml.includes(HEADER_OLD)) throw new Error(`header not found in ${srcMigration}`);
  const newMjml = mjml.replace(HEADER_OLD, HEADER_NEW);
  const newDesign = rewriteHeaderJson(json);
  const { html, errors } = mjml2html(newMjml, { validationLevel: 'soft' });
  if (errors && errors.length) console.warn(`${srcMigration}: ${errors.length} mjml warnings`);
  return { mjml: newMjml, html, design: newDesign };
}

const confirmation = build(
  resolve(repo, 'packages/db/prisma/migrations/20260610170000_order_no_in_header/migration.sql'),
);
const shipped = build(
  resolve(repo, 'packages/db/prisma/migrations/20260610180000_order_shipped_trim/migration.sql'),
);

// ---- migration ----
function upsert(id, name, t) {
  return `INSERT INTO "email_templates" ("id", "scope", "name", "mjml", "html", "design_json", "created_at", "updated_at")
VALUES (
  '${id}',
  'system',
  '${name}',
  $mjml$${t.mjml}$mjml$,
  $html$${t.html}$html$,
  $json$${JSON.stringify(t.design)}$json$::jsonb,
  now(),
  now()
)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "mjml" = EXCLUDED."mjml",
  "html" = EXCLUDED."html",
  "design_json" = EXCLUDED."design_json",
  "updated_at" = now();`;
}

const migration = `-- Order confirmation + shipped: move the order number under the shop name
-- (single left-aligned header column) instead of right of it.

${upsert('00000000-0000-4000-8000-000000000005', '订单确认通知（默认）', confirmation)}

${upsert('00000000-0000-4000-8000-000000000006', '订单发货通知（默认）', shipped)}
`;

const migDir = resolve(repo, 'packages/db/prisma/migrations/20260610190000_order_no_left');
mkdirSync(migDir, { recursive: true });
writeFileSync(resolve(migDir, 'migration.sql'), migration);

// ---- ts builders ----
function tsFile(kind, idConst, subjectConst, idVal, subjectVal, t) {
  return `/** System default ${kind} template — block-based easy-email designJson. */
export const ${idConst} = "${idVal}";
export const ${subjectConst} = ${JSON.stringify(subjectVal)};

export const ${camel(kind)}DesignJson = ${JSON.stringify(t.design, null, 2)} as const;

export const ${camel(kind)}Mjml = ${JSON.stringify(t.mjml)};

export const ${camel(kind)}Html = ${JSON.stringify(t.html)};
`;
}
function camel(kind) {
  return kind === 'orderConfirmation' ? 'orderConfirmation' : 'orderShipped';
}

writeFileSync(
  resolve(repo, 'packages/db/src/order-confirmation-template.ts'),
  tsFile(
    'orderConfirmation',
    'ORDER_CONFIRMATION_TEMPLATE_ID',
    'ORDER_CONFIRMATION_SUBJECT',
    '00000000-0000-4000-8000-000000000005',
    confirmation.design.subject,
    confirmation,
  ),
);
writeFileSync(
  resolve(repo, 'packages/db/src/order-shipped-template.ts'),
  tsFile(
    'orderShipped',
    'ORDER_SHIPPED_TEMPLATE_ID',
    'ORDER_SHIPPED_SUBJECT',
    '00000000-0000-4000-8000-000000000006',
    shipped.design.subject,
    shipped,
  ),
);

console.log('wrote migration + 2 ts builders');
console.log('confirmation html bytes:', confirmation.html.length, 'has {{order_items}}:', confirmation.html.includes('{{order_items}}'), 'has {{order_no}}:', confirmation.html.includes('{{order_no}}'));
console.log('shipped html bytes:', shipped.html.length, 'has {{tracking_number}}:', shipped.html.includes('{{tracking_number}}'), 'has {{tracking_url}}:', shipped.html.includes('{{tracking_url}}'), 'has {{order_items}}:', shipped.html.includes('{{order_items}}'));
