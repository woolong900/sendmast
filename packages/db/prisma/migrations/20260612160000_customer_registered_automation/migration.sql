ALTER TYPE "shop_automation_type" ADD VALUE IF NOT EXISTS 'customer_registered';

INSERT INTO "email_templates" (
  "id",
  "scope",
  "name",
  "html",
  "created_at",
  "updated_at"
)
VALUES (
  '00000000-0000-4000-8000-000000000007',
  'system'::"template_scope",
  '顾客注册欢迎（默认）',
  $html$<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>Welcome</title>
  <style>
    body { margin: 0; background: #f4f4f5; }
    @media (max-width: 600px) {
      .container { width: 92% !important; }
      .content { padding: 32px 24px !important; }
      .cta, .cta a { display: block !important; width: 100% !important; box-sizing: border-box; }
    }
  </style>
</head>
<body style="margin:0;background:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0;border-collapse:collapse;background:#f4f4f5;">
    <tr>
      <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Helvetica Neue',Arial,sans-serif;">
        <table class="container" role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;margin:40px auto 16px;border-spacing:0;border-collapse:collapse;">
          <tr>
            <td style="font-size:26px;font-weight:600;color:#111827;">{{shop_name}}</td>
          </tr>
        </table>
        <table class="container" role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;margin:0 auto;border-spacing:0;border-collapse:collapse;background:#ffffff;border-radius:10px;">
          <tr>
            <td class="content" style="padding:44px 36px;">
              <h1 style="margin:0 0 14px;font-size:28px;line-height:1.25;color:#111827;">Welcome to {{shop_name}}</h1>
              <p style="margin:0 0 28px;font-size:16px;line-height:1.7;color:#52525b;">Hi {{full_name}}, thanks for creating an account with us. You can now enjoy a faster checkout and keep track of your orders in one place.</p>
              <table class="cta" role="presentation" cellpadding="0" cellspacing="0" style="border-spacing:0;border-collapse:collapse;">
                <tr>
                  <td align="center" bgcolor="#111827" style="border-radius:6px;">
                    <a href="{{shop_url}}" style="display:inline-block;padding:14px 30px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">Visit our store</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <table class="container" role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;margin:0 auto;border-spacing:0;border-collapse:collapse;">
          <tr>
            <td align="center" style="padding:24px 16px 36px;font-size:13px;line-height:1.6;color:#9ca3af;">
              You received this email because you created an account with {{shop_name}}.
              <a href="{{unsubscribe_url}}" style="color:#71717a;text-decoration:underline;">Unsubscribe</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>$html$,
  now(),
  now()
)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "scope" = EXCLUDED."scope",
  "html" = EXCLUDED."html",
  "updated_at" = now();
