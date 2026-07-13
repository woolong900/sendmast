UPDATE "send_logs"
SET "final_html" = NULL
WHERE "source" = 'automation'
  AND "final_html" IS NOT NULL;
