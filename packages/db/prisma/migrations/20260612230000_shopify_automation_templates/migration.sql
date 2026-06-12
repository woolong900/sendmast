-- Refresh Shopify-style defaults without overwriting merchant-customized inline content.

UPDATE "shop_automations" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><div class="pad" style="padding:38px 42px 42px;">
<h1 style="margin:0 0 12px;font-size:28px;line-height:1.25;font-weight:600;">You left something behind</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, the items in your cart are still waiting for you. Complete your purchase while they're available.</p>
<h2 style="margin:0 0 8px;font-size:18px;font-weight:600;">Your cart</h2>
{{order_items}}
{{coupon_block}}
<div style="height:24px;line-height:24px;">&nbsp;</div>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{tracking_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Return to checkout</a></td></tr></table>
</div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">Don't want to receive cart reminders from {{shop_name}}?<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE "template_id" = '00000000-0000-4000-8000-000000000004' AND ("html" IS NULL OR "html" = (SELECT "html" FROM "email_templates" WHERE "id" = '00000000-0000-4000-8000-000000000004'));
UPDATE "shop_automation_steps" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><div class="pad" style="padding:38px 42px 42px;">
<h1 style="margin:0 0 12px;font-size:28px;line-height:1.25;font-weight:600;">You left something behind</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, the items in your cart are still waiting for you. Complete your purchase while they're available.</p>
<h2 style="margin:0 0 8px;font-size:18px;font-weight:600;">Your cart</h2>
{{order_items}}
{{coupon_block}}
<div style="height:24px;line-height:24px;">&nbsp;</div>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{tracking_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Return to checkout</a></td></tr></table>
</div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">Don't want to receive cart reminders from {{shop_name}}?<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE ("template_id" = '00000000-0000-4000-8000-000000000004' OR ("template_id" IS NULL AND "automation_id" IN (SELECT "id" FROM "shop_automations" WHERE "template_id" = '00000000-0000-4000-8000-000000000004'))) AND ("html" IS NULL OR "html" = (SELECT "html" FROM "email_templates" WHERE "id" = '00000000-0000-4000-8000-000000000004'));
UPDATE "email_templates" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><div class="pad" style="padding:38px 42px 42px;">
<h1 style="margin:0 0 12px;font-size:28px;line-height:1.25;font-weight:600;">You left something behind</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, the items in your cart are still waiting for you. Complete your purchase while they're available.</p>
<h2 style="margin:0 0 8px;font-size:18px;font-weight:600;">Your cart</h2>
{{order_items}}
{{coupon_block}}
<div style="height:24px;line-height:24px;">&nbsp;</div>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{tracking_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Return to checkout</a></td></tr></table>
</div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">Don't want to receive cart reminders from {{shop_name}}?<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE "id" = '00000000-0000-4000-8000-000000000004';
UPDATE "shop_automations" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">Thank you for your purchase!</h1>
<p style="margin:0 0 28px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, we're getting your order ready. We'll notify you when it has been sent.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{order_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">View your order</a></td></tr></table>
<h2 style="margin:36px 0 8px;font-size:18px;font-weight:600;">Order summary</h2>
{{order_items}}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e1e3e5;"><tr><td style="padding:18px 0;font-size:15px;color:#6d7175;">Total</td><td align="right" style="padding:18px 0;font-size:18px;font-weight:700;">{{order_total}}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:1px solid #e1e3e5;"><tr><td class="split" width="50%" valign="top" style="padding-top:24px;"><div style="font-size:15px;font-weight:600;margin-bottom:8px;">Shipping address</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">{{shipping_address}}</div></td><td class="split" width="50%" valign="top" style="padding:24px 0 0 24px;"><div style="font-size:15px;font-weight:600;margin-bottom:8px;">Order details</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">Order #{{order_no}}<br>Total {{order_total}}</div></td></tr></table>
</div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">You received this email because you placed an order with {{shop_name}}.<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE "template_id" = '00000000-0000-4000-8000-000000000005' AND ("html" IS NULL OR "html" = (SELECT "html" FROM "email_templates" WHERE "id" = '00000000-0000-4000-8000-000000000005'));
UPDATE "email_templates" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">Thank you for your purchase!</h1>
<p style="margin:0 0 28px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, we're getting your order ready. We'll notify you when it has been sent.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{order_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">View your order</a></td></tr></table>
<h2 style="margin:36px 0 8px;font-size:18px;font-weight:600;">Order summary</h2>
{{order_items}}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e1e3e5;"><tr><td style="padding:18px 0;font-size:15px;color:#6d7175;">Total</td><td align="right" style="padding:18px 0;font-size:18px;font-weight:700;">{{order_total}}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:1px solid #e1e3e5;"><tr><td class="split" width="50%" valign="top" style="padding-top:24px;"><div style="font-size:15px;font-weight:600;margin-bottom:8px;">Shipping address</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">{{shipping_address}}</div></td><td class="split" width="50%" valign="top" style="padding:24px 0 0 24px;"><div style="font-size:15px;font-weight:600;margin-bottom:8px;">Order details</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">Order #{{order_no}}<br>Total {{order_total}}</div></td></tr></table>
</div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">You received this email because you placed an order with {{shop_name}}.<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE "id" = '00000000-0000-4000-8000-000000000005';
UPDATE "shop_automations" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">Your order is on the way</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, your order has shipped. Use the link below to follow its journey.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{tracking_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Track your shipment</a></td></tr></table>
<div style="margin:26px 0 0;padding:16px 18px;background:#f6f6f4;border-radius:6px;font-size:14px;line-height:1.6;color:#6d7175;"><strong style="color:#202223;">Tracking number</strong><br><a href="{{tracking_url}}" style="color:#2f6f55;">{{tracking_number}}</a></div>
<h2 style="margin:34px 0 8px;font-size:18px;font-weight:600;">Items in this shipment</h2>
{{order_items}}
</div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">You received this email because you placed an order with {{shop_name}}.<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE "template_id" = '00000000-0000-4000-8000-000000000006' AND ("html" IS NULL OR "html" = (SELECT "html" FROM "email_templates" WHERE "id" = '00000000-0000-4000-8000-000000000006'));
UPDATE "email_templates" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">Your order is on the way</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, your order has shipped. Use the link below to follow its journey.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{tracking_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Track your shipment</a></td></tr></table>
<div style="margin:26px 0 0;padding:16px 18px;background:#f6f6f4;border-radius:6px;font-size:14px;line-height:1.6;color:#6d7175;"><strong style="color:#202223;">Tracking number</strong><br><a href="{{tracking_url}}" style="color:#2f6f55;">{{tracking_number}}</a></div>
<h2 style="margin:34px 0 8px;font-size:18px;font-weight:600;">Items in this shipment</h2>
{{order_items}}
</div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">You received this email because you placed an order with {{shop_name}}.<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE "id" = '00000000-0000-4000-8000-000000000006';
UPDATE "shop_automations" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><img src="https://app.sendmast.com/assets/automation-welcome-banner-v1.jpg" width="600" alt="Welcome" style="display:block;width:100%;height:auto;border:0;">
<div class="pad" style="padding:38px 42px 42px;">
<h1 style="margin:0 0 14px;font-size:28px;line-height:1.25;font-weight:600;">Welcome to {{shop_name}}</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, thanks for creating an account with us. You can now check out faster and keep track of your orders in one place.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{shop_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Visit our store</a></td></tr></table></div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">You received this email because you created an account with {{shop_name}}.<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE "template_id" = '00000000-0000-4000-8000-000000000007' AND ("html" IS NULL OR "html" = (SELECT "html" FROM "email_templates" WHERE "id" = '00000000-0000-4000-8000-000000000007'));
UPDATE "email_templates" SET "html" = $html$<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{shop_name}}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">{{shop_name}}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;"><img src="https://app.sendmast.com/assets/automation-welcome-banner-v1.jpg" width="600" alt="Welcome" style="display:block;width:100%;height:auto;border:0;">
<div class="pad" style="padding:38px 42px 42px;">
<h1 style="margin:0 0 14px;font-size:28px;line-height:1.25;font-weight:600;">Welcome to {{shop_name}}</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, thanks for creating an account with us. You can now check out faster and keep track of your orders in one place.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#2f6f55" style="border-radius:6px;background:#2f6f55;"><a href="{{shop_url}}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Visit our store</a></td></tr></table></div></td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">You received this email because you created an account with {{shop_name}}.<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>$html$, "mjml" = NULL, "design_json" = NULL, "updated_at" = now() WHERE "id" = '00000000-0000-4000-8000-000000000007';
