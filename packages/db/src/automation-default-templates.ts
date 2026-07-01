const APP_ASSET_BASE = 'https://app.sendmast.com/assets';
const GREEN = '#2f6f55';
const STORE_NAME = '{{shop_name}}';

export const CUSTOMER_REGISTERED_TEMPLATE_ID = '00000000-0000-4000-8000-000000000007';
export const ABANDONED_CART_TEMPLATE_ID = '00000000-0000-4000-8000-000000000004';
export const ORDER_CONFIRMATION_TEMPLATE_ID = '00000000-0000-4000-8000-000000000005';
export const ORDER_SHIPPED_TEMPLATE_ID = '00000000-0000-4000-8000-000000000006';
export const REVIEW_REQUEST_TEMPLATE_ID = '00000000-0000-4000-8000-000000000008';
export const PAYMENT_FAILED_TEMPLATE_ID = '00000000-0000-4000-8000-000000000009';
export const ORDER_REFUNDED_TEMPLATE_ID = '00000000-0000-4000-8000-000000000010';
export const POINTS_EXPIRING_TEMPLATE_ID = '00000000-0000-4000-8000-000000000011';

function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="${GREEN}" style="border-radius:6px;background:${GREEN};"><a href="${href}" target="_blank" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${label}</a></td></tr></table>`;
}

function shell(content: string, reason: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${STORE_NAME}</title>
<style>@media(max-width:620px){.wrap{width:100%!important}.pad{padding:28px 22px!important}.split{display:block!important;width:100%!important}.split+ .split{padding-top:24px!important;padding-left:0!important}}</style></head>
<body style="margin:0;background:#f6f6f4;color:#202223;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px;">
<table class="wrap" role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
<tr><td style="padding:0 8px 20px;font-size:25px;font-weight:600;color:#202223;">${STORE_NAME}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e1e3e5;border-radius:8px;overflow:hidden;">${content}</td></tr>
<tr><td align="center" style="padding:24px 16px 0;font-size:12px;line-height:1.6;color:#8c9196;">${reason}<br><a href="{{unsubscribe_url}}" style="color:#6d7175;">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

export const customerRegisteredHtml = shell(
  `<img src="${APP_ASSET_BASE}/automation-welcome-banner-v2.jpg" width="600" alt="Welcome" style="display:block;width:100%;height:auto;border:0;">
<div class="pad" style="padding:38px 42px 42px;">
<h1 style="margin:0 0 14px;font-size:28px;line-height:1.25;font-weight:600;">Welcome to ${STORE_NAME}</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, thanks for creating an account with us. You can now check out faster and keep track of your orders in one place.</p>
${button('Visit our store', '{{shop_url}}')}</div>`,
  `You received this email because you created an account with ${STORE_NAME}.`,
);

export const orderConfirmationHtml = shell(
  `<div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">Thank you for your purchase!</h1>
<p style="margin:0 0 28px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, we're getting your order ready. We'll notify you when it has been sent.</p>
${button('View your order', '{{thanks_url}}')}
<h2 style="margin:36px 0 8px;font-size:18px;font-weight:600;">Order summary</h2>
{{order_items}}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e1e3e5;"><tr><td style="padding:18px 0;font-size:15px;color:#6d7175;">Total</td><td align="right" style="padding:18px 0;font-size:18px;font-weight:700;">{{order_total}}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:1px solid #e1e3e5;"><tr><td class="split" width="50%" valign="top" style="padding-top:24px;"><div style="font-size:15px;font-weight:600;margin-bottom:8px;">Shipping address</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">{{shipping_address}}</div></td><td class="split" width="50%" valign="top" style="padding:24px 0 0 24px;"><div style="font-size:15px;font-weight:600;margin-bottom:8px;">Billing address</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">{{billing_address}}</div></td></tr></table>
</div>`,
  `You received this email because you placed an order with ${STORE_NAME}.`,
);

export const orderShippedHtml = shell(
  `<div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">Your order is on the way</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, your order has shipped. Use the link below to follow its journey.</p>
${button('Track your shipment', '{{tracking_url}}')}
<div style="margin:26px 0 0;padding:16px 18px;background:#f6f6f4;border-radius:6px;font-size:14px;line-height:1.6;color:#6d7175;"><strong style="color:#202223;">Tracking number</strong><br><a href="{{tracking_url}}" style="color:${GREEN};">{{tracking_number}}</a></div>
<h2 style="margin:34px 0 8px;font-size:18px;font-weight:600;">Items in this shipment</h2>
{{order_items}}
</div>`,
  `You received this email because you placed an order with ${STORE_NAME}.`,
);

export const abandonedCartHtml = shell(
  `<div class="pad" style="padding:38px 42px 42px;">
<h1 style="margin:0 0 12px;font-size:28px;line-height:1.25;font-weight:600;">You left something behind</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, the items in your cart are still waiting for you. Complete your purchase while they're available.</p>
<h2 style="margin:0 0 8px;font-size:18px;font-weight:600;">Your cart</h2>
{{order_items}}
{{coupon_block}}
<div style="height:24px;line-height:24px;">&nbsp;</div>
${button('Return to checkout', '{{order_url}}')}
</div>`,
  `Don't want to receive cart reminders from ${STORE_NAME}?`,
);

export const reviewRequestHtml = shell(
  `<div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">How did we do?</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, we hope you are enjoying your recent purchase. Your feedback helps us improve and helps other customers shop with confidence.</p>
{{order_items}}
<div style="margin:24px 0;font-size:30px;letter-spacing:4px;color:#d69b2d;">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
${button('Write a review', '{{review_url}}')}
</div>`,
  `You received this email after shopping with ${STORE_NAME}.`,
);

export const paymentFailedHtml = shell(
  `<div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">We couldn't process your payment</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, there was a problem processing payment for your order. Your items are still reserved for a limited time.</p>
<div style="margin-bottom:24px;padding:18px 20px;border-left:4px solid #d95545;background:#fff1ef;border-radius:6px;color:#8b3c32;font-size:14px;line-height:1.6;"><strong>Payment needs attention</strong><br>Please update your payment details to complete your purchase.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border-top:1px solid #e1e3e5;"><tr><td style="padding:16px 0;color:#6d7175;">Order total</td><td align="right" style="padding:16px 0;font-weight:600;">{{order_total}}</td></tr><tr><td style="padding:16px 0;border-top:1px solid #e1e3e5;color:#6d7175;">Payment method</td><td align="right" style="padding:16px 0;border-top:1px solid #e1e3e5;font-weight:600;">{{payment_method}}</td></tr></table>
${button('Update payment', '{{payment_url}}')}
</div>`,
  `Need help? Reply to this email and the ${STORE_NAME} team will assist you.`,
);

export const orderRefundedHtml = shell(
  `<div class="pad" style="padding:38px 42px 42px;">
<div style="font-size:13px;font-weight:600;color:#6d7175;text-transform:uppercase;">Order #{{order_no}}</div>
<h1 style="margin:8px 0 12px;font-size:28px;line-height:1.25;font-weight:600;">Your refund is on the way</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, we have issued a refund for your order. It will be returned to your original payment method.</p>
<div style="margin-bottom:24px;padding:20px 22px;background:#f2f5f3;border-radius:6px;"><div style="font-size:14px;color:#6d7175;">Refund amount</div><div style="margin-top:6px;font-size:29px;font-weight:700;">{{refund_amount}}</div></div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;"><tr><td valign="top" style="padding:4px 12px 16px 0;color:${GREEN};">&#9679;</td><td style="padding-bottom:16px;font-size:14px;line-height:1.5;"><strong>Refund issued</strong><br><span style="color:#6d7175;">{{refund_date}}</span></td></tr><tr><td valign="top" style="padding:4px 12px 0 0;color:${GREEN};">&#9679;</td><td style="font-size:14px;line-height:1.5;"><strong>Expected arrival</strong><br><span style="color:#6d7175;">Within 5–10 business days</span></td></tr></table>
${button('View order details', '{{order_url}}')}
</div>`,
  `You received this email because a refund was issued by ${STORE_NAME}.`,
);

export const pointsExpiringHtml = shell(
  `<div style="padding:38px 42px;background:#dce9df;color:#24533f;"><div style="font-size:13px;font-weight:700;text-transform:uppercase;">Rewards balance</div><div style="margin-top:18px;font-size:48px;line-height:1;font-weight:700;">{{points_balance}}</div><div style="margin-top:5px;font-size:14px;font-weight:600;">points available</div></div>
<div class="pad" style="padding:38px 42px 42px;">
<h1 style="margin:0 0 14px;font-size:28px;line-height:1.25;font-weight:600;">Use your points before they expire</h1>
<p style="margin:0 0 26px;font-size:16px;line-height:1.65;color:#6d7175;">Hi {{full_name}}, you have rewards waiting. Redeem them on your next purchase before they expire.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border-top:1px solid #bfd4c5;"><tr><td style="padding:16px 0;color:#47705a;">Expiration date</td><td align="right" style="padding:16px 0;font-weight:600;color:#24533f;">{{expiration_date}}</td></tr></table>
${button('Redeem rewards', '{{rewards_url}}')}
</div>`,
  `You received this email as a member of ${STORE_NAME} Rewards.`,
);
