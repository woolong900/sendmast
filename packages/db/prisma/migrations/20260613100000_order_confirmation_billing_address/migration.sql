UPDATE "email_templates"
SET "html" = replace(
      "html",
      '<div style="font-size:15px;font-weight:600;margin-bottom:8px;">Order details</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">Order #{{order_no}}<br>Total {{order_total}}</div>',
      '<div style="font-size:15px;font-weight:600;margin-bottom:8px;">Billing address</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">{{billing_address}}</div>'
    ),
    "updated_at" = now()
WHERE "id" = '00000000-0000-4000-8000-000000000005'
  AND "html" LIKE '%Order details%';

UPDATE "shop_automations"
SET "html" = replace(
      "html",
      '<div style="font-size:15px;font-weight:600;margin-bottom:8px;">Order details</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">Order #{{order_no}}<br>Total {{order_total}}</div>',
      '<div style="font-size:15px;font-weight:600;margin-bottom:8px;">Billing address</div><div style="font-size:14px;line-height:1.65;color:#6d7175;">{{billing_address}}</div>'
    ),
    "updated_at" = now()
WHERE "type" = 'order_paid'::"shop_automation_type"
  AND "html" LIKE '%Order details%';
