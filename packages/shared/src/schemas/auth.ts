import { z } from 'zod';

/**
 * Tenant lifecycle state. New signups land in `pending_activation`; backend
 * promotes to `active` when the activation link is redeemed; admins can
 * suspend (writes blocked, reads still work) and unsuspend.
 */
export const AccountStatusSchema = z.enum(['pending_activation', 'active', 'suspended']);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

// Email is case-insensitive per RFC 5321 §2.4 (local-part technically is,
// but every mail server in practice treats it as not). We lowercase + trim
// at the schema boundary so the DB only ever stores one canonical form,
// avoiding "Foo@x.com" and "foo@x.com" colliding (or worse, BOTH being
// allowed to sign up).
const emailField = z.string().trim().toLowerCase().pipe(z.string().email());

export const SignupSchema = z.object({
  email: emailField,
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(80).optional(),
  accountName: z.string().min(1).max(80),
  /// Optional partner referral code carried from `/signup?ref=<code>`.
  /// We accept any short alphanumeric string here and let the backend
  /// resolve it: unknown / disabled codes are silently ignored so a
  /// stale link never blocks signup.
  referralCode: z.string().trim().toUpperCase().max(32).optional(),
});
export type SignupInput = z.infer<typeof SignupSchema>;

export const LoginSchema = z.object({
  email: emailField,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof RefreshSchema>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    isPlatformAdmin: boolean;
    emailVerified: boolean;
  };
  account: {
    id: string;
    name: string;
    slug: string;
    role: string;
    status: AccountStatus;
    /** Filled when status === 'suspended', shown in the suspended banner. */
    suspendedReason: string | null;
  };
}

export const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

export const ForgotPasswordSchema = z.object({
  email: emailField,
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export interface ResetTokenValidateResponse {
  ok: boolean;
  email?: string;
  expiresAt?: string;
}

export const ActivateSchema = z.object({
  token: z.string().min(1),
});
export type ActivateInput = z.infer<typeof ActivateSchema>;

/** Result of POST /api/auth/activate. `ok=false` covers expired/used/invalid. */
export interface ActivateResponse {
  ok: boolean;
  /** Set on success; UI uses it to greet the user before redirecting. */
  email?: string;
}
