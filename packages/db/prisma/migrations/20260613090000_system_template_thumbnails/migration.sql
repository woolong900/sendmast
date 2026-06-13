UPDATE "email_templates"
SET "thumbnail" = CASE "id"
  WHEN '00000000-0000-4000-8000-000000000001' THEN 'https://app.sendmast.com/assets/system-template-thumbnails/welcome.webp'
  WHEN '00000000-0000-4000-8000-000000000002' THEN 'https://app.sendmast.com/assets/system-template-thumbnails/product-launch.webp'
  WHEN '00000000-0000-4000-8000-000000000003' THEN 'https://app.sendmast.com/assets/system-template-thumbnails/newsletter.webp'
  WHEN '00000000-0000-4000-8000-000000000004' THEN 'https://app.sendmast.com/assets/system-template-thumbnails/abandoned-cart.webp'
  WHEN '00000000-0000-4000-8000-000000000005' THEN 'https://app.sendmast.com/assets/system-template-thumbnails/order-confirmation.webp'
  WHEN '00000000-0000-4000-8000-000000000006' THEN 'https://app.sendmast.com/assets/system-template-thumbnails/order-shipped.webp'
  WHEN '00000000-0000-4000-8000-000000000007' THEN 'https://app.sendmast.com/assets/system-template-thumbnails/customer-registered.webp'
END,
"updated_at" = now()
WHERE "id" IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007'
);
