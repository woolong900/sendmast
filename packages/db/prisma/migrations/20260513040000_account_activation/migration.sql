-- Lifecycle states for tenants: enforced by AccountWriteGuard interceptor
-- (suspended blocks all writes) and additionally by Campaign create/start
-- handlers (pending_activation blocks those two endpoints).
CREATE TYPE "account_status" AS ENUM ('pending_activation', 'active', 'suspended');

-- New tenants land in pending_activation; existing tenants are grandfathered
-- to active (they predate this feature, no point asking them to re-verify).
ALTER TABLE "accounts"
    ADD COLUMN "status"            "account_status" NOT NULL DEFAULT 'pending_activation',
    ADD COLUMN "activated_at"      TIMESTAMP(3),
    ADD COLUMN "suspended_at"      TIMESTAMP(3),
    ADD COLUMN "suspended_reason"  TEXT;

UPDATE "accounts" SET "status" = 'active', "activated_at" = "created_at";

-- Single-use activation tokens (mirrors password_reset_tokens). Plaintext
-- token never lands in the DB; we store SHA-256(token).
CREATE TABLE "email_verification_tokens" (
    "id"             UUID         PRIMARY KEY,
    "user_id"        UUID         NOT NULL,
    "token_hash"     TEXT         NOT NULL UNIQUE,
    "expires_at"     TIMESTAMP(3) NOT NULL,
    "used_at"        TIMESTAMP(3),
    "requested_ip"   TEXT,
    "requested_ua"   TEXT,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_verification_tokens_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "email_verification_tokens_user_id_created_at_idx"
    ON "email_verification_tokens" ("user_id", "created_at");

-- Seed the email_activation template so the activation flow works out of
-- the box even before the admin customises copy.
INSERT INTO "notification_templates" ("code", "name", "description", "subject", "body_html", "variables") VALUES (
  'email_activation',
  '邮箱激活',
  '新用户注册后收到的激活邮件，点击按钮后账号才能创建/发送邮件活动。',
  '【sendwalk】激活您的账号',
  '<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 0;">
      <tr><td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);overflow:hidden;">
          <tr><td style="padding:32px 32px 16px;">
            <div style="font-size:18px;font-weight:600;color:#0f172a;">您好，{{userName}}</div>
            <div style="font-size:14px;color:#475569;margin-top:12px;line-height:1.6;">
              欢迎使用 sendwalk。请点击下面的按钮激活您的账号，激活后才能创建并发送邮件活动。
            </div>
          </td></tr>
          <tr><td align="center" style="padding:8px 32px 24px;">
            <a href="{{activateUrl}}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:500;font-size:14px;padding:12px 28px;border-radius:8px;">
              激活账号
            </a>
          </td></tr>
          <tr><td style="padding:0 32px 32px;font-size:12px;color:#94a3b8;line-height:1.6;">
            链接将于 <b>{{expiresInHours}}</b> 小时后失效。如果按钮无法点击，请将以下链接复制到浏览器：<br/>
            <a href="{{activateUrl}}" style="color:#10b981;word-break:break-all;">{{activateUrl}}</a><br/><br/>
            如果不是您本人注册的账号，请忽略此邮件。
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>',
  '["userName","activateUrl","expiresInHours"]'::jsonb
);
