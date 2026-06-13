import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  abandonedCartHtml,
  customerRegisteredHtml,
  orderConfirmationHtml,
  orderShippedHtml,
} from './automation-default-templates';

const prisma = new PrismaClient();
const SYSTEM_THUMBNAIL_BASE = 'https://app.sendmast.com/assets/system-template-thumbnails';

const SYSTEM_TEMPLATES: Array<{
  name: string;
  thumbnail: string;
  mjml?: string;
  /** Pre-rendered HTML (for templates authored directly as HTML, not MJML). */
  html?: string;
  /** easy-email designJson so the block editor can render/edit the template. */
  designJson?: unknown;
}> = [
  {
    name: 'Welcome',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/welcome.webp`,
    html: welcomeHtml(),
  },
  {
    name: 'Product Launch',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/product-launch.webp`,
    html: productLaunchHtml(),
  },
  {
    name: 'Newsletter',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/newsletter.webp`,
    html: newsletterHtml(),
  },
  {
    name: '弃单召回（默认）',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/abandoned-cart.webp`,
    html: abandonedCartHtml,
  },
  {
    name: '订单确认通知（默认）',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/order-confirmation.webp`,
    html: orderConfirmationHtml,
  },
  {
    name: '订单发货通知（默认）',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/order-shipped.webp`,
    html: orderShippedHtml,
  },
  {
    name: '顾客注册欢迎（默认）',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/customer-registered.webp`,
    html: customerRegisteredHtml,
  },
];

async function main() {
  for (const tpl of SYSTEM_TEMPLATES) {
    const html = tpl.html ?? '';
    const mjml = tpl.mjml ?? null;
    const designJson = (tpl.designJson ?? null) as never;
    await prisma.emailTemplate.upsert({
      where: { id: deterministicId(tpl.name) },
      update: { thumbnail: tpl.thumbnail, mjml, html, designJson },
      create: {
        id: deterministicId(tpl.name),
        scope: 'system',
        name: tpl.name,
        thumbnail: tpl.thumbnail,
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
    '订单确认通知（默认）': '00000000-0000-4000-8000-000000000005',
    '订单发货通知（默认）': '00000000-0000-4000-8000-000000000006',
    '顾客注册欢迎（默认）': '00000000-0000-4000-8000-000000000007',
  };
  return map[name] ?? randomUUID();
}

function marketingShell(content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#202223;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;">${content}</table></td></tr></table></body></html>`;
}

function welcomeHtml(): string {
  return marketingShell(`<tr><td style="padding:52px 42px;background:#dce9df;"><div style="font-size:13px;color:#47705a;font-weight:700;">{{sender_domain}}</div><h1 style="font-size:34px;line-height:1.2;margin:18px 0 12px;">Welcome to our community</h1><p style="font-size:16px;line-height:1.6;color:#52605a;margin:0 0 26px;">Hi {{full_name}}, thanks for joining us. We are delighted to have you here.</p><a href="#" style="display:inline-block;background:#2f6f55;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:5px;font-weight:600;">Explore the store</a></td></tr>`);
}

function productLaunchHtml(): string {
  return marketingShell(`<tr><td style="padding:54px 38px;background:#202d26;color:#ffffff;"><div style="font-size:12px;color:#b9c9c0;font-weight:700;">NEW ARRIVAL</div><h1 style="font-size:34px;line-height:1.2;margin:10px 0 0;">Made for every day</h1></td></tr><tr><td style="padding:32px 38px;"><p style="font-size:16px;line-height:1.6;color:#5f6662;margin:0 0 24px;">Meet a thoughtful new essential designed to go wherever you do.</p><a href="#" style="display:inline-block;background:#2f6f55;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:5px;font-weight:600;">Shop the collection</a></td></tr>`);
}

function newsletterHtml(): string {
  return marketingShell(`<tr><td style="padding:38px;border-bottom:1px solid #e1e3e5;"><div style="font-size:12px;color:#47705a;font-weight:700;">THE MONTHLY EDIT</div><h1 style="font-size:32px;line-height:1.2;margin:12px 0 0;">Fresh ideas for the month</h1></td></tr><tr><td style="padding:28px 38px;"><h2 style="font-size:20px;margin:0 0 10px;">A slower, better routine</h2><p style="font-size:15px;line-height:1.6;color:#606763;margin:0 0 24px;">Stories, products, and inspiration selected for the month ahead.</p><hr style="border:0;border-top:1px solid #e1e3e5;margin:0 0 24px;"><h2 style="font-size:20px;margin:0;">What we are loving</h2></td></tr>`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
