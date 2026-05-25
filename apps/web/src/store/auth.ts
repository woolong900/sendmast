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
}

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  account: AuthAccount | null;
  setSession(payload: {
    token: string;
    refreshToken: string;
    user?: AuthUser | null;
    account?: AuthAccount | null;
  }): void;
  setProfile(p: { user: AuthUser; account: AuthAccount }): void;
  logout(): void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      refreshToken: null,
      user: null,
      account: null,
      setSession: ({ token, refreshToken, user, account }) =>
        set({
          token,
          refreshToken,
          user: user ?? null,
          account: account ?? null,
        }),
      setProfile: ({ user, account }) => set({ user, account }),
      logout: () => set({ token: null, refreshToken: null, user: null, account: null }),
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
