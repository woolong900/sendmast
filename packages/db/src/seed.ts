import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const SYSTEM_TEMPLATES: Array<{
  name: string;
  category: string;
  mjml?: string;
  /** Pre-rendered HTML (for templates authored directly as HTML, not MJML). */
  html?: string;
  /** easy-email designJson so the block editor can render/edit the template. */
  designJson?: unknown;
}> = [
  {
    name: 'Welcome',
    category: 'basic',
    mjml: welcomeMjml(),
  },
  {
    name: 'Product Launch',
    category: 'promotion',
    mjml: launchMjml(),
  },
  {
    name: 'Newsletter',
    category: 'basic',
    mjml: newsletterMjml(),
  },
  {
    name: '弃单召回（默认）',
    category: 'promotion',
    html: abandonedCartHtml(),
    designJson: abandonedCartDesignJson(),
  },
];

async function main() {
  for (const tpl of SYSTEM_TEMPLATES) {
    const html = tpl.html ?? '';
    const mjml = tpl.mjml ?? null;
    const designJson = (tpl.designJson ?? null) as never;
    await prisma.emailTemplate.upsert({
      where: { id: deterministicId(tpl.name) },
      update: { mjml, html, designJson, category: tpl.category },
      create: {
        id: deterministicId(tpl.name),
        scope: 'system',
        name: tpl.name,
        category: tpl.category,
        mjml,
        html,
        designJson,
      },
    });
  }
  console.log(`Seeded ${SYSTEM_TEMPLATES.length} system templates.`);
}

function deterministicId(name: string): string {
  // Stable UUIDv5-ish using a fixed namespace; avoids drift across reseeds.
  // For seed simplicity we just hand-pick UUIDs by name.
  const map: Record<string, string> = {
    Welcome: '00000000-0000-4000-8000-000000000001',
    'Product Launch': '00000000-0000-4000-8000-000000000002',
    Newsletter: '00000000-0000-4000-8000-000000000003',
    '弃单召回（默认）': '00000000-0000-4000-8000-000000000004',
  };
  return map[name] ?? randomUUID();
}

function welcomeMjml(): string {
  return `<mjml><mj-body><mj-section><mj-column><mj-text font-size="20px">Welcome to {{company_name}}!</mj-text><mj-text>Thanks for subscribing. We are excited to have you on board.</mj-text></mj-column></mj-section></mj-body></mjml>`;
}

function launchMjml(): string {
  return `<mjml><mj-body><mj-section><mj-column><mj-text font-size="24px">Introducing our new product</mj-text><mj-button href="{{cta_url}}">Shop now</mj-button></mj-column></mj-section></mj-body></mjml>`;
}

function newsletterMjml(): string {
  return `<mjml><mj-body><mj-section><mj-column><mj-text font-size="20px">Monthly Newsletter</mj-text><mj-text>Here are this month highlights.</mj-text></mj-column></mj-section></mj-body></mjml>`;
}

/**
 * System default abandoned-cart recovery template (adapted from the Shopify
 * abandoned-checkout email). Authored as HTML; uses SendMast merge variables
 * resolved by worker-sender's flow send path. Keep in sync with the
 * `abandoned_cart_default_template` migration.
 */
function abandonedCartHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width">
<title>You left items in your cart</title>
<style>
  body { margin: 0; }
  a { color: #111827; }
  @media (max-width: 600px) {
    .container { width: 92% !important; }
    .cta, .cta a { width: 100% !important; display: block !important; }
  }
</style>
</head>
<body style="margin:0; background:#f4f4f5;">
${abandonedCartInner()}
</body>
</html>`;
}

/**
 * Body-inner markup shared by the rendered HTML above and the easy-email `raw`
 * block in {@link abandonedCartDesignJson}. The `page` wrapper provides the
 * <html>/<head>; head-only rules (a:link color, mobile media query) live in the
 * page's user-style. Keep in sync with the `abandoned_cart_default_*` migrations.
 */
function abandonedCartInner(): string {
  return `  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse; background:#f4f4f5;">
    <tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Helvetica Neue',Arial,sans-serif;">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse; margin:40px 0 20px;">
          <tr><td align="center">
            <table class="container" role="presentation" cellpadding="0" cellspacing="0" style="width:560px; text-align:left; border-spacing:0; border-collapse:collapse; margin:0 auto;">
              <tr><td>
                <h1 style="font-weight:normal; font-size:28px; color:#111827; margin:0;">{{sender_domain}}</h1>
              </td></tr>
            </table>
          </td></tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse;">
          <tr><td align="center">
            <table class="container" role="presentation" cellpadding="0" cellspacing="0" style="width:560px; text-align:left; border-spacing:0; border-collapse:collapse; margin:0 auto; background:#ffffff; border-radius:10px;">
              <tr><td style="padding:36px 32px;">
                <h2 style="font-weight:600; font-size:24px; color:#111827; margin:0 0 12px;">You left items in your cart</h2>
                <p style="color:#555555; line-height:1.6; font-size:16px; margin:0 0 24px;">Hi {{full_name}}, you added items to your shopping cart but haven&rsquo;t completed your purchase yet. Complete it now while they&rsquo;re still available.</p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse; background:#f9fafb; border:1px solid #eceff3; border-radius:8px; margin:0 0 28px;">
                  <tr>
                    <td style="padding:16px 18px 6px; font-size:14px; color:#6b7280;">Order</td>
                    <td align="right" style="padding:16px 18px 6px; font-size:14px; color:#111827; font-weight:600;">{{order_no}}</td>
                  </tr>
                  <tr>
                    <td style="padding:0 18px 16px; font-size:14px; color:#6b7280;">Total</td>
                    <td align="right" style="padding:0 18px 16px; font-size:18px; color:#111827; font-weight:700;">{{order_total}}</td>
                  </tr>
                </table>

                <table class="cta" role="presentation" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse;">
                  <tr>
                    <td align="center" bgcolor="#111827" style="border-radius:6px;">
                      <a href="{{tracking_url}}" style="display:inline-block; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; padding:16px 34px;">Complete your purchase</a>
                    </td>
                  </tr>
                </table>
              </td></tr>
            </table>
          </td></tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse;">
          <tr><td align="center" style="padding:28px 0;">
            <table class="container" role="presentation" cellpadding="0" cellspacing="0" style="width:560px; text-align:center; border-spacing:0; border-collapse:collapse; margin:0 auto;">
              <tr><td>
                <p style="color:#9ca3af; line-height:1.6; font-size:13px; margin:0;">Don&rsquo;t want to receive cart reminders? <a href="{{unsubscribe_url}}" style="color:#9ca3af; text-decoration:underline;">Unsubscribe</a></p>
              </td></tr>
            </table>
          </td></tr>
        </table>

      </td>
    </tr>
  </table>`;
}

/**
 * easy-email designJson that wraps {@link abandonedCartInner} in a single `raw`
 * block under the page, so the block editor renders/edits the template instead
 * of showing a blank canvas. Keep in sync with the
 * `abandoned_cart_default_design_json` migration.
 */
function abandonedCartDesignJson(): unknown {
  return {
    subject: 'Complete your purchase',
    subTitle: '',
    content: {
      type: 'page',
      data: {
        value: {
          breakpoint: '480px',
          headAttributes: '',
          'font-size': '14px',
          'font-weight': '400',
          'line-height': '1.7',
          headStyles: [],
          fonts: [],
          responsive: true,
          'font-family':
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
          'text-color': '#111827',
          'user-style': {
            content:
              'body{margin:0;} a{color:#111827;} @media (max-width:600px){.container{width:92%!important;}.cta,.cta a{width:100%!important;display:block!important;}}',
          },
        },
      },
      attributes: { 'background-color': '#f4f4f5', width: '600px' },
      children: [
        {
          type: 'raw',
          data: { value: { content: abandonedCartInner() } },
          attributes: {},
          children: [],
        },
      ],
    },
  };
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
