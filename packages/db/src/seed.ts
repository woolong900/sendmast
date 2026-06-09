import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  abandonedCartDesignJson,
  abandonedCartHtml,
  abandonedCartMjml,
} from './abandoned-cart-template';

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
    mjml: abandonedCartMjml,
    html: abandonedCartHtml,
    designJson: abandonedCartDesignJson,
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

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
