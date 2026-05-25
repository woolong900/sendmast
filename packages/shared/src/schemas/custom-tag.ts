import { z } from 'zod';

/**
 * Custom tag = per-account placeholder used in subject / preheader / html body.
 * At send time worker-sender substitutes `{{tag:<name>}}` with one of the
 * configured `values`, chosen at random per recipient.
 *
 * Naming rules:
 *   - lowercase ASCII letters, digits, hyphen, underscore
 *   - 1..40 chars
 *   - unique per account (DB enforces via composite unique index)
 * The lowercase + restricted-charset rule keeps placeholders unambiguous to
 * parse and avoids confusing matches against unrelated text.
 */
export const CustomTagNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_-]+$/, '只能使用小写字母、数字、下划线和短横线');

/**
 * Each tag carries 1..50 candidate values. We cap at 50 to keep the
 * configuration UI sane; bump the limit if real-world use needs it.
 * Empty-string values are rejected so the substitution can't silently
 * disappear text (use a meaningful placeholder string instead).
 */
export const CustomTagValuesSchema = z
  .array(z.string().min(1).max(2000))
  .min(1, '至少需要一个值')
  .max(50, '最多 50 个值');

export const CreateCustomTagSchema = z.object({
  name: CustomTagNameSchema,
  values: CustomTagValuesSchema,
});
export type CreateCustomTagInput = z.infer<typeof CreateCustomTagSchema>;

export const UpdateCustomTagSchema = z.object({
  // name is intentionally NOT updatable: changing it would silently break
  // any in-flight or scheduled campaign referencing the old name. Users
  // should delete and recreate if they really need to rename.
  values: CustomTagValuesSchema,
});
export type UpdateCustomTagInput = z.infer<typeof UpdateCustomTagSchema>;

export interface CustomTagView {
  id: string;
  name: string;
  values: string[];
  createdAt: string;
  updatedAt: string;
}
