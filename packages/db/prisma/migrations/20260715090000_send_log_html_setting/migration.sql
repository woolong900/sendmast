CREATE TABLE "send_log_settings" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "automation_final_html_log_enabled" BOOLEAN NOT NULL DEFAULT false,
  "updated_by" UUID,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "send_log_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "send_log_settings" ("id", "automation_final_html_log_enabled")
VALUES ('singleton', false)
ON CONFLICT ("id") DO NOTHING;
