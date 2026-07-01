import { z } from 'zod';

export const TemplateScopeSchema = z.enum(['system', 'user']);
export type TemplateScopeValue = z.infer<typeof TemplateScopeSchema>;

export const CreateTemplateSchema = z
  .object({
    name: z.string().min(1).max(120),
    thumbnail: z.string().optional(),
    // Either `mjml` (legacy MJML editor) or `html` (Unlayer / drag-drop) must
    // be provided. `designJson` is the editor's internal state for re-opening.
    mjml: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    designJson: z.unknown().optional(),
  })
  .refine((v) => !!v.mjml || !!v.html, {
    message: 'Either mjml or html is required',
    path: ['html'],
  });
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;

export const UpdateTemplateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    thumbnail: z.string().optional(),
    mjml: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    designJson: z.unknown().optional(),
  });
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;

export const ListTemplatesQuerySchema = z.object({
  scope: TemplateScopeSchema.optional(),
});
export type ListTemplatesQuery = z.infer<typeof ListTemplatesQuerySchema>;
