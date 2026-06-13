INSERT INTO "email_templates" ("id", "scope", "name", "thumbnail", "html", "created_at", "updated_at")
VALUES
(
  '00000000-0000-4000-8000-000000000001',
  'system'::"template_scope",
  'Welcome',
  'https://app.sendmast.com/assets/system-template-thumbnails/welcome.webp',
  '<!doctype html><html lang="en"><body style="margin:0;background:#dce9df;font-family:Arial,sans-serif;color:#202223;"><div style="max-width:560px;margin:32px auto;padding:52px 42px;"><h1>Welcome to our community</h1><p>Hi {{full_name}}, thanks for joining us. We are delighted to have you here.</p></div></body></html>',
  now(),
  now()
),
(
  '00000000-0000-4000-8000-000000000002',
  'system'::"template_scope",
  'Product Launch',
  'https://app.sendmast.com/assets/system-template-thumbnails/product-launch.webp',
  '<!doctype html><html lang="en"><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#202223;"><div style="max-width:560px;margin:32px auto;background:#ffffff;"><div style="padding:54px 38px;background:#202d26;color:#ffffff;"><h1>Made for every day</h1></div><div style="padding:32px 38px;"><p>Meet a thoughtful new essential designed to go wherever you do.</p></div></div></body></html>',
  now(),
  now()
),
(
  '00000000-0000-4000-8000-000000000003',
  'system'::"template_scope",
  'Newsletter',
  'https://app.sendmast.com/assets/system-template-thumbnails/newsletter.webp',
  '<!doctype html><html lang="en"><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#202223;"><div style="max-width:560px;margin:32px auto;background:#ffffff;padding:38px;"><h1>Fresh ideas for the month</h1><h2>A slower, better routine</h2><p>Stories, products, and inspiration selected for the month ahead.</p></div></body></html>',
  now(),
  now()
)
ON CONFLICT ("id") DO UPDATE SET
  "scope" = EXCLUDED."scope",
  "name" = EXCLUDED."name",
  "thumbnail" = EXCLUDED."thumbnail",
  "html" = EXCLUDED."html",
  "updated_at" = now();
