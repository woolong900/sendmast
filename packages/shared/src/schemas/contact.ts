import { z } from 'zod';

export const SubscriptionStatusSchema = z.enum([
  'subscribed',
  'unsubscribed',
  'bounced',
  'complained',
  'pending',
]);
export type SubscriptionStatusValue = z.infer<typeof SubscriptionStatusSchema>;

export const CreateContactListSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});
export type CreateContactListInput = z.infer<typeof CreateContactListSchema>;

export const UpdateContactListSchema = CreateContactListSchema.partial();
export type UpdateContactListInput = z.infer<typeof UpdateContactListSchema>;

export const CreateContactSchema = z.object({
  // Canonical-lowercase emails (RFC 5321 §2.4 compat). Same rationale as the
  // auth schemas — keeps the @@unique([accountId, email]) index from
  // accepting case-variant duplicates of the same contact.
  email: z.string().trim().toLowerCase().pipe(z.string().email()),
  firstName: z.string().max(80).optional(),
  lastName: z.string().max(80).optional(),
  phone: z.string().max(40).optional(),
  gender: z.string().max(20).optional(),
  country: z.string().max(80).optional(),
  state: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
  zip: z.string().max(20).optional(),
  birthday: z.string().optional(),
  language: z.string().max(20).optional(),
  source: z.string().max(60).optional(),
  listIds: z.array(z.string().uuid()).optional(),
});
export type CreateContactInput = z.infer<typeof CreateContactSchema>;

export const BatchContactActionSchema = z
  .object({
    action: z.enum(['subscribe', 'unsubscribe', 'removeFromList']),
    ids: z.array(z.string().uuid()).min(1).max(1000),
    listId: z.string().uuid().optional(),
  })
  .refine((v) => v.action !== 'removeFromList' || !!v.listId, {
    message: 'listId is required for removeFromList',
    path: ['listId'],
  });
export type BatchContactActionInput = z.infer<typeof BatchContactActionSchema>;

export const ListContactsQuerySchema = z.object({
  search: z.string().optional(),
  status: SubscriptionStatusSchema.optional(),
  listId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuerySchema>;
