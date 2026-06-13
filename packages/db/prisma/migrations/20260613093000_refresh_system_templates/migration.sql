DELETE FROM "email_templates"
WHERE "scope" = 'system'::"template_scope"
  AND "id" IN (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003'
  );

UPDATE "email_templates"
SET "html" = replace("html", '{{shop_name}}', 'My Store'),
    "mjml" = CASE WHEN "mjml" IS NULL THEN NULL ELSE replace("mjml", '{{shop_name}}', 'My Store') END,
    "design_json" = CASE
      WHEN "design_json" IS NULL THEN NULL
      ELSE replace("design_json"::text, '{{shop_name}}', 'My Store')::jsonb
    END,
    "updated_at" = now()
WHERE "scope" = 'system'::"template_scope";

UPDATE "shop_automations"
SET "html" = CASE WHEN "html" IS NULL THEN NULL ELSE replace("html", '{{shop_name}}', 'My Store') END,
    "mjml" = CASE WHEN "mjml" IS NULL THEN NULL ELSE replace("mjml", '{{shop_name}}', 'My Store') END,
    "design_json" = CASE
      WHEN "design_json" IS NULL THEN NULL
      ELSE replace("design_json"::text, '{{shop_name}}', 'My Store')::jsonb
    END,
    "subject" = CASE WHEN "subject" IS NULL THEN NULL ELSE replace("subject", '{{shop_name}}', 'My Store') END,
    "updated_at" = now();

UPDATE "shop_automation_steps"
SET "html" = CASE WHEN "html" IS NULL THEN NULL ELSE replace("html", '{{shop_name}}', 'My Store') END,
    "mjml" = CASE WHEN "mjml" IS NULL THEN NULL ELSE replace("mjml", '{{shop_name}}', 'My Store') END,
    "design_json" = CASE
      WHEN "design_json" IS NULL THEN NULL
      ELSE replace("design_json"::text, '{{shop_name}}', 'My Store')::jsonb
    END,
    "subject" = CASE WHEN "subject" IS NULL THEN NULL ELSE replace("subject", '{{shop_name}}', 'My Store') END,
    "updated_at" = now();

INSERT INTO "email_templates" ("id", "scope", "name", "thumbnail", "html", "created_at", "updated_at")
VALUES
(
  '00000000-0000-4000-8000-000000000008',
  'system'::"template_scope",
  '邀请评价',
  'https://app.sendmast.com/assets/system-template-thumbnails/review-request.webp',
  $html$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>My Store</title></head><body style="margin:0;background:#f6f6f4;color:#202223;font-family:Arial,sans-serif;"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 12px;"><table role="presentation" width="600" style="max-width:600px;"><tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;">My Store</td></tr><tr><td style="padding:38px 42px;background:#fff;border:1px solid #e1e3e5;border-radius:8px;"><div style="font-size:13px;color:#6d7175;">ORDER #{{order_no}}</div><h1>How did we do?</h1><p style="color:#6d7175;line-height:1.65;">Hi {{full_name}}, we hope you are enjoying your recent purchase. Your feedback helps us improve and helps other customers shop with confidence.</p>{{order_items}}<div style="margin:24px 0;font-size:30px;color:#d69b2d;">★★★★★</div><a href="{{review_url}}" style="display:inline-block;padding:14px 24px;background:#2f6f55;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Write a review</a></td></tr></table></td></tr></table></body></html>$html$,
  now(),
  now()
),
(
  '00000000-0000-4000-8000-000000000009',
  'system'::"template_scope",
  '订单支付失败',
  'https://app.sendmast.com/assets/system-template-thumbnails/payment-failed.webp',
  $html$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>My Store</title></head><body style="margin:0;background:#f6f6f4;color:#202223;font-family:Arial,sans-serif;"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 12px;"><table role="presentation" width="600" style="max-width:600px;"><tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;">My Store</td></tr><tr><td style="padding:38px 42px;background:#fff;border:1px solid #e1e3e5;border-radius:8px;"><div style="font-size:13px;color:#6d7175;">ORDER #{{order_no}}</div><h1>We couldn't process your payment</h1><p style="color:#6d7175;line-height:1.65;">Hi {{full_name}}, there was a problem processing payment for your order. Your items are still reserved for a limited time.</p><div style="padding:18px 20px;border-left:4px solid #d95545;background:#fff1ef;color:#8b3c32;"><strong>Payment needs attention</strong><br>Please update your payment details to complete your purchase.</div><p>Order total: <strong>{{order_total}}</strong></p><p>Payment method: <strong>{{payment_method}}</strong></p><a href="{{payment_url}}" style="display:inline-block;padding:14px 24px;background:#2f6f55;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Update payment</a></td></tr></table></td></tr></table></body></html>$html$,
  now(),
  now()
),
(
  '00000000-0000-4000-8000-000000000010',
  'system'::"template_scope",
  '订单退款',
  'https://app.sendmast.com/assets/system-template-thumbnails/order-refunded.webp',
  $html$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>My Store</title></head><body style="margin:0;background:#f6f6f4;color:#202223;font-family:Arial,sans-serif;"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 12px;"><table role="presentation" width="600" style="max-width:600px;"><tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;">My Store</td></tr><tr><td style="padding:38px 42px;background:#fff;border:1px solid #e1e3e5;border-radius:8px;"><div style="font-size:13px;color:#6d7175;">ORDER #{{order_no}}</div><h1>Your refund is on the way</h1><p style="color:#6d7175;line-height:1.65;">Hi {{full_name}}, we have issued a refund for your order. It will be returned to your original payment method.</p><div style="padding:20px 22px;background:#f2f5f3;border-radius:6px;"><span style="color:#6d7175;">Refund amount</span><div style="font-size:29px;font-weight:700;">{{refund_amount}}</div></div><p><strong>Refund issued</strong><br>{{refund_date}}</p><p><strong>Expected arrival</strong><br>Within 5–10 business days</p><a href="{{order_url}}" style="display:inline-block;padding:14px 24px;background:#2f6f55;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">View order details</a></td></tr></table></td></tr></table></body></html>$html$,
  now(),
  now()
),
(
  '00000000-0000-4000-8000-000000000011',
  'system'::"template_scope",
  '积分即将过期',
  'https://app.sendmast.com/assets/system-template-thumbnails/points-expiring.webp',
  $html$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>My Store</title></head><body style="margin:0;background:#f6f6f4;color:#202223;font-family:Arial,sans-serif;"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 12px;"><table role="presentation" width="600" style="max-width:600px;"><tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;">My Store</td></tr><tr><td style="padding:38px 42px;background:#dce9df;color:#24533f;"><strong>REWARDS BALANCE</strong><div style="margin-top:18px;font-size:48px;font-weight:700;">{{points_balance}}</div><div>points available</div></td></tr><tr><td style="padding:38px 42px;background:#fff;border:1px solid #e1e3e5;"><h1>Use your points before they expire</h1><p style="color:#6d7175;line-height:1.65;">Hi {{full_name}}, you have rewards waiting. Redeem them on your next purchase before they expire.</p><p>Expiration date: <strong>{{expiration_date}}</strong></p><a href="{{rewards_url}}" style="display:inline-block;padding:14px 24px;background:#2f6f55;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Redeem rewards</a></td></tr></table></td></tr></table></body></html>$html$,
  now(),
  now()
)
ON CONFLICT ("id") DO UPDATE SET
  "scope" = EXCLUDED."scope",
  "name" = EXCLUDED."name",
  "thumbnail" = EXCLUDED."thumbnail",
  "html" = EXCLUDED."html",
  "mjml" = NULL,
  "design_json" = NULL,
  "updated_at" = now();
