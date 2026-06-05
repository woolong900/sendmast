import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  /** True after the user clicks the activation link in their email. */
  emailVerified?: boolean;
}
export interface AuthAccount {
  id: string;
  name: string;
  slug: string;
  role: string;
  /** Tenant lifecycle. Drives the activation banner and the create-campaign gate. */
  status?: 'pending_activation' | 'active' | 'suspended';
  suspendedReason?: string | null;
  /**
   * Collaborator (trusted partner) account. Normal tenants (false/undefined)
   * see the softened analytics view — soft bounces folded into 送达 and 弹回率
   * hidden. Collaborators (true) see the real deliverability data.
   */
  isCollaborator?: boolean;
}

/**
 * Set whenever the calling Platform Admin is acting "as" another tenant via
 * the 代登录 flow. Drives the yellow top banner + the «退出代登录» button.
 * Hydrated from `/api/auth/me`'s `impersonation` field.
 */
export interface ImpersonationInfo {
  originalUser: {
    id: string;
    email: string;
    displayName: string | null;
  };
}

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  account: AuthAccount | null;
  impersonation: ImpersonationInfo | null;
  setSession(payload: {
    token: string;
    refreshToken: string;
    user?: AuthUser | null;
    account?: AuthAccount | null;
  }): void;
  setProfile(p: {
    user: AuthUser;
    account: AuthAccount;
    impersonation?: ImpersonationInfo | null;
  }): void;
  logout(): void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      refreshToken: null,
      user: null,
      account: null,
      impersonation: null,
      setSession: ({ token, refreshToken, user, account }) =>
        set({
          token,
          refreshToken,
          user: user ?? null,
          account: account ?? null,
        }),
      setProfile: ({ user, account, impersonation }) =>
        set({ user, account, impersonation: impersonation ?? null }),
      logout: () =>
        set({
          token: null,
          refreshToken: null,
          user: null,
          account: null,
          impersonation: null,
        }),
    }),
    { name: 'sendmast-auth' },
  ),
);

// Cross-tab sync: when one tab refreshes the access/refresh token pair, the
// other tabs need to pick up the new values from localStorage immediately,
// otherwise their next request would still send the (now revoked) old refresh
// token and get bounced to /login. zustand persist does NOT subscribe to
// `storage` events automatically — we wire it up here.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'sendmast-auth') {
      void useAuth.persist.rehydrate();
    }
  });
}
