-- Add the {{order_items}} product-list block to the default abandoned-cart
-- template. worker-shop-sync renders the cart line items (thumbnail + title ×
-- qty) into this merge var at send time. Re-sets both `html` (the sent body)
-- and `design_json` (the editor's source, raw block) so they stay in sync.
-- Idempotent (keyed on id); dollar-quoted to avoid escaping the HTML.
UPDATE "email_templates"
SET
  "html" = $html$<!DOCTYPE html>
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
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse; background:#f4f4f5;">
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

                {{order_items}}

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
  </table>
</body>
</html>$html$,
  "design_json" = jsonb_build_object(
    'subject', 'Complete your purchase',
    'subTitle', '',
    'content', jsonb_build_object(
      'type', 'page',
      'data', jsonb_build_object('value', jsonb_build_object(
        'breakpoint', '480px',
        'headAttributes', '',
        'font-size', '14px',
        'font-weight', '400',
        'line-height', '1.7',
        'headStyles', '[]'::jsonb,
        'fonts', '[]'::jsonb,
        'responsive', true,
        'font-family', '-apple-system, BlinkMacSystemFont, ''Segoe UI'', ''Roboto'', ''Helvetica Neue'', Arial, sans-serif',
        'text-color', '#111827',
        'user-style', jsonb_build_object('content', 'body{margin:0;} a{color:#111827;} @media (max-width:600px){.container{width:92%!important;}.cta,.cta a{width:100%!important;display:block!important;}}')
      )),
      'attributes', jsonb_build_object('background-color', '#f4f4f5', 'width', '600px'),
      'children', jsonb_build_array(
        jsonb_build_object(
          'type', 'raw',
          'data', jsonb_build_object('value', jsonb_build_object('content', $raw$  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-spacing:0; border-collapse:collapse; background:#f4f4f5;">
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

                {{order_items}}

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
  </table>$raw$)),
          'attributes', '{}'::jsonb,
          'children', '[]'::jsonb
        )
      )
    )
  ),
  "updated_at" = now()
WHERE "id" = '00000000-0000-4000-8000-000000000004';
