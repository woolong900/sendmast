import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  abandonedCartHtml,
  customerRegisteredHtml,
  orderConfirmationHtml,
  orderRefundedHtml,
  orderShippedHtml,
  paymentFailedHtml,
  pointsExpiringHtml,
  reviewRequestHtml,
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
  {
    name: '邀请评价',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/review-request.webp`,
    html: reviewRequestHtml,
  },
  {
    name: '订单支付失败',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/payment-failed.webp`,
    html: paymentFailedHtml,
  },
  {
    name: '订单退款',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/order-refunded.webp`,
    html: orderRefundedHtml,
  },
  {
    name: '积分即将过期',
    thumbnail: `${SYSTEM_THUMBNAIL_BASE}/points-expiring.webp`,
    html: pointsExpiringHtml,
  },
];

async function main() {
  await prisma.emailTemplate.deleteMany({
    where: {
      scope: 'system',
      id: {
        in: [
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
        ],
      },
    },
  });

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
    '弃单召回（默认）': '00000000-0000-4000-8000-000000000004',
    '订单确认通知（默认）': '00000000-0000-4000-8000-000000000005',
    '订单发货通知（默认）': '00000000-0000-4000-8000-000000000006',
    '顾客注册欢迎（默认）': '00000000-0000-4000-8000-000000000007',
    邀请评价: '00000000-0000-4000-8000-000000000008',
    订单支付失败: '00000000-0000-4000-8000-000000000009',
    订单退款: '00000000-0000-4000-8000-000000000010',
    积分即将过期: '00000000-0000-4000-8000-000000000011',
  };
  return map[name] ?? randomUUID();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
