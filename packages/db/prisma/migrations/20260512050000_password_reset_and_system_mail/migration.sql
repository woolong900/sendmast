-- Single-use, time-bound tokens for the "forgot password" flow.
CREATE TABLE "password_reset_tokens" (
    "id"             UUID         PRIMARY KEY,
    "user_id"        UUID         NOT NULL,
    "token_hash"     TEXT         NOT NULL UNIQUE,
    "expires_at"     TIMESTAMP(3) NOT NULL,
    "used_at"        TIMESTAMP(3),
    "requested_ip"   TEXT,
    "requested_ua"   TEXT,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_reset_tokens_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "password_reset_tokens_user_id_created_at_idx"
    ON "password_reset_tokens" ("user_id", "created_at");

-- Singleton platform-wide SMTP config. Only one row, id='singleton'.
CREATE TABLE "system_smtp_config" (
    "id"            TEXT         PRIMARY KEY DEFAULT 'singleton',
    "host"          TEXT         NOT NULL,
    "port"          INTEGER      NOT NULL,
    "secure"        BOOLEAN      NOT NULL DEFAULT true,
    "username"      TEXT         NOT NULL,
    "password"      TEXT         NOT NULL,
    "from_name"     TEXT         NOT NULL,
    "from_address"  TEXT         NOT NULL,
    "reply_to"      TEXT,
    "updated_by"    UUID,
    "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Editable system email templates. `code` is a closed enum coupled to backend.
CREATE TABLE "notification_templates" (
    "code"        TEXT         PRIMARY KEY,
    "name"        TEXT         NOT NULL,
    "description" TEXT,
    "subject"     TEXT         NOT NULL,
    "body_html"   TEXT         NOT NULL,
    "variables"   JSONB        NOT NULL DEFAULT '[]',
    "updated_by"  UUID,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed the password_reset template so the forgot-password flow works
-- out of the box even if the admin hasn't customised it.
INSERT INTO "notification_templates" ("code", "name", "description", "subject", "body_html", "variables") VALUES (
  'password_reset',
  '密码重置',
  '用户在登录页点击 "忘记密码" 后收到的邮件。',
  '【sendwalk】重置您的密码',
  '<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 0;">
      <tr><td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);overflow:hidden;">
          <tr><td style="padding:32px 32px 16px;">
            <div style="font-size:18px;font-weight:600;color:#0f172a;">您好，{{userName}}</div>
            <div style="font-size:14px;color:#475569;margin-top:12px;line-height:1.6;">
              我们收到了您重置 sendwalk 账号密码的请求。点击下面的按钮即可设置新密码：
            </div>
          </td></tr>
          <tr><td align="center" style="padding:8px 32px 24px;">
            <a href="{{resetUrl}}" style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;font-weight:500;font-size:14px;padding:12px 28px;border-radius:8px;">
              重置密码
            </a>
          </td></tr>
          <tr><td style="padding:0 32px 32px;font-size:12px;color:#94a3b8;line-height:1.6;">
            链接将于 <b>{{expiresInHours}}</b> 小时后失效。如果按钮无法点击，请将以下链接复制到浏览器：<br/>
            <a href="{{resetUrl}}" style="color:#3b82f6;word-break:break-all;">{{resetUrl}}</a><br/><br/>
            如果不是您本人的操作，请忽略此邮件，您的密码不会被更改。
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>',
  '["userName","resetUrl","expiresInHours"]'::jsonb
);
