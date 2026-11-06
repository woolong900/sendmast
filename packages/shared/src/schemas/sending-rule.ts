import { z } from 'zod';

function normalizedPattern(max: number, message: string) {
  return z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(
      z
        .string()
        .min(1, message)
        .max(max, message)
        .regex(/^[a-z0-9._%+*@?-]+$/, message),
    );
}

export const SenderDomainPatternSchema = normalizedPattern(253, '发件域名规则格式不正确').refine(
  (value) => !value.includes('@'),
  '发件域名规则不能包含 @',
);

export const SendingRuleRecipientPatternSchema = normalizedPattern(
  254,
  '收件邮箱规则格式不正确',
).refine(
  (value) => (value.match(/@/g) ?? []).length <= 1,
  '收件邮箱规则格式不正确',
);

export const SendingRuleModeSchema = z.enum(['allow', 'block']);
export type SendingRuleMode = z.infer<typeof SendingRuleModeSchema>;

export const CreateSendingRuleSchema = z.object({
  mode: SendingRuleModeSchema,
  senderDomainPattern: SenderDomainPatternSchema,
  recipientPattern: SendingRuleRecipientPatternSchema,
});
export type CreateSendingRuleInput = z.infer<typeof CreateSendingRuleSchema>;

export interface SendingRuleView {
  id: string;
  mode: SendingRuleMode;
  senderDomainPattern: string;
  recipientPattern: string;
  createdAt: string;
  updatedAt: string;
}
