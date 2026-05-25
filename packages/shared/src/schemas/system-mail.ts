import { z } from 'zod';

// ---------- SMTP config ----------
// Singleton platform-wide SMTP credentials. Only platform admins can read or
// write. Per project decision, password is stored in plaintext (DB-only access
// control); UI still masks it on display.

export const SystemSmtpConfigInputSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(255),
  fromName: z.string().min(1).max(120),
  fromAddress: z.string().email(),
  replyTo: z.string().email().optional().or(z.literal('')),
});
export type SystemSmtpConfigInput = z.infer<typeof SystemSmtpConfigInputSchema>;

export interface SystemSmtpConfigView {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** "********" — UI displays as masked, only sent back when admin clicks "show". */
  passwordMasked: string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  updatedAt: string;
  configured: boolean;
}

// "Send a test email" payload — admin specifies recipient + which template.
export const SendTestMailSchema = z.object({
  to: z.string().email(),
  templateCode: z.string().min(1),
});
export type SendTestMailInput = z.infer<typeof SendTestMailSchema>;

// ---------- Notification templates ----------

export interface NotificationTemplateView {
  code: string;
  name: string;
  description: string | null;
  subject: string;
  bodyHtml: string;
  /** Allowed `{{var}}` substitutions for this template. */
  variables: string[];
  updatedAt: string;
}

export const UpdateNotificationTemplateSchema = z.object({
  subject: z.string().min(1).max(300),
  bodyHtml: z.string().min(1).max(50_000),
});
export type UpdateNotificationTemplateInput = z.infer<typeof UpdateNotificationTemplateSchema>;
