import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  NotificationTemplateView,
  SystemSmtpConfigInput,
  SystemSmtpConfigView,
  UpdateNotificationTemplateInput,
} from '@sendmast/shared';

const SINGLETON_ID = 'singleton';

/// Closed enum of template codes the backend may dispatch. Adding a new code
/// here also requires an INSERT into notification_templates (do via migration
/// so admins inherit a sane default). Admin can edit subject/body in the UI
/// but cannot create new codes.
export const TEMPLATE_CODES = ['password_reset', 'email_activation'] as const;
export type TemplateCode = (typeof TEMPLATE_CODES)[number];

@Injectable()
export class SystemMailService {
  private readonly logger = new Logger(SystemMailService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------- SMTP config (singleton) ------------------------------------

  async getConfigRaw() {
    return this.prisma.systemSmtpConfig.findUnique({ where: { id: SINGLETON_ID } });
  }

  async getConfigView(): Promise<SystemSmtpConfigView | null> {
    const c = await this.getConfigRaw();
    if (!c) return null;
    return {
      host: c.host,
      port: c.port,
      secure: c.secure,
      username: c.username,
      passwordMasked: c.password ? '••••••••' : '',
      fromName: c.fromName,
      fromAddress: c.fromAddress,
      replyTo: c.replyTo,
      updatedAt: c.updatedAt.toISOString(),
      configured: true,
    };
  }

  async upsertConfig(input: SystemSmtpConfigInput, updatedBy?: string) {
    const data = {
      host: input.host.trim(),
      port: input.port,
      secure: input.secure,
      username: input.username.trim(),
      password: input.password,
      fromName: input.fromName.trim(),
      fromAddress: input.fromAddress.trim().toLowerCase(),
      replyTo: input.replyTo?.trim() || null,
      updatedBy: updatedBy ?? null,
    };
    await this.prisma.systemSmtpConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
  }

  // ---------- Templates ---------------------------------------------------

  async listTemplates(): Promise<NotificationTemplateView[]> {
    const rows = await this.prisma.notificationTemplate.findMany({
      orderBy: { code: 'asc' },
    });
    return rows.map((r) => this.toTemplateView(r));
  }

  async getTemplate(code: string): Promise<NotificationTemplateView> {
    const row = await this.prisma.notificationTemplate.findUnique({ where: { code } });
    if (!row) throw new NotFoundException(`模板 ${code} 不存在`);
    return this.toTemplateView(row);
  }

  async updateTemplate(
    code: string,
    input: UpdateNotificationTemplateInput,
    updatedBy?: string,
  ): Promise<NotificationTemplateView> {
    const existing = await this.prisma.notificationTemplate.findUnique({ where: { code } });
    if (!existing) throw new NotFoundException(`模板 ${code} 不存在`);
    const updated = await this.prisma.notificationTemplate.update({
      where: { code },
      data: {
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        updatedBy: updatedBy ?? null,
      },
    });
    return this.toTemplateView(updated);
  }

  // ---------- Sending -----------------------------------------------------

  /** Render a template's subject + body with the supplied variables. */
  async render(
    code: TemplateCode,
    vars: Record<string, string>,
  ): Promise<{ subject: string; html: string }> {
    const tpl = await this.prisma.notificationTemplate.findUnique({ where: { code } });
    if (!tpl) throw new NotFoundException(`模板 ${code} 不存在`);
    return {
      subject: substitute(tpl.subject, vars),
      html: substitute(tpl.bodyHtml, vars),
    };
  }

  /**
   * Render + send a templated email. Throws if SMTP isn't configured or the
   * SMTP server rejects. Synchronous on purpose (per design choice A) so
   * callers can react to send failures inline.
   */
  async sendTemplated(
    code: TemplateCode,
    to: string,
    vars: Record<string, string>,
  ): Promise<void> {
    const { subject, html } = await this.render(code, vars);
    await this.sendRaw({ to, subject, html });
  }

  /** Plain send. Used for the "test send" button. */
  async sendRaw(input: { to: string; subject: string; html: string }): Promise<void> {
    const cfg = await this.getConfigRaw();
    if (!cfg) {
      throw new BadRequestException(
        '系统邮件服务未配置,请先在 平台管理 → 系统邮件 中填入 SMTP 信息。',
      );
    }
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.username, pass: cfg.password },
    });
    try {
      await transporter.sendMail({
        from: { name: cfg.fromName, address: cfg.fromAddress },
        to: input.to,
        subject: input.subject,
        html: input.html,
        replyTo: cfg.replyTo ?? undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`SMTP send failed → ${input.to}: ${msg}`);
      throw new BadRequestException(`邮件发送失败:${msg}`);
    }
  }

  /** Test-send: render a template with placeholder values and dispatch. */
  async sendTest(to: string, code: string): Promise<void> {
    if (!TEMPLATE_CODES.includes(code as TemplateCode)) {
      throw new BadRequestException(`未知的模板代码：${code}`);
    }
    const tpl = await this.prisma.notificationTemplate.findUnique({ where: { code } });
    if (!tpl) throw new NotFoundException(`模板 ${code} 不存在`);
    // Fill all known variables with obvious "[example]" markers so the admin
    // can see how the email will actually render.
    const vars: Record<string, string> = {};
    for (const v of (tpl.variables as string[]) ?? []) {
      vars[v] = `[${v} 示例值]`;
    }
    await this.sendTemplated(code as TemplateCode, to, vars);
  }

  private toTemplateView(row: {
    code: string;
    name: string;
    description: string | null;
    subject: string;
    bodyHtml: string;
    variables: unknown;
    updatedAt: Date;
  }): NotificationTemplateView {
    return {
      code: row.code,
      name: row.name,
      description: row.description,
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      variables: Array.isArray(row.variables) ? (row.variables as string[]) : [],
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Replace every `{{varName}}` occurrence with `vars[varName]`. */
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}
