import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuth } from '@/store/auth';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export const api = axios.create({
  baseURL: BASE_URL,
  withCredentials: false,
});

api.interceptors.request.use((cfg) => {
  const token = useAuth.getState().token;
  if (token) {
    cfg.headers = cfg.headers ?? {};
    cfg.headers.Authorization = `Bearer ${token}`;
  }
  return cfg;
});

// ---- Refresh-on-401 with single-flight de-duplication ----------------------
//
// Backend access tokens expire after JWT_ACCESS_TTL (1h). On any 401 from a
// protected endpoint we try once to swap our refresh token for a fresh access
// token, then replay the original request. If refresh itself fails (refresh
// token expired/revoked → user truly idle for >12h, or password rotated on
// another device), we wipe the session and bounce to /login.
//
// Concurrency: when the user comes back to the tab, multiple components fire
// requests in parallel. They all 401 nearly simultaneously. We must NOT call
// /auth/refresh once per request — the first call rotates and revokes the
// refresh token, and all later calls would fail with "Invalid refresh token"
// then erroneously log the user out. The `refreshInFlight` promise serialises
// every parallel 401 onto a single network refresh.

let refreshInFlight: Promise<string | null> | null = null;

// Endpoints that should NEVER trigger the refresh dance — either they're
// public (login/signup) or they're the refresh endpoint itself (loop guard)
// or they're best-effort and we don't want to keep them alive (logout).
const AUTH_BYPASS = ['/api/auth/login', '/api/auth/signup', '/api/auth/refresh', '/api/auth/logout'];

async function doRefresh(): Promise<string | null> {
  const state = useAuth.getState();
  const refreshToken = state.refreshToken;
  if (!refreshToken) return null;
  try {
    // Use raw axios (not the `api` instance) so this call doesn't re-enter
    // our own response interceptor on the way out.
    const r = await axios.post(`${BASE_URL}/api/auth/refresh`, { refreshToken });
    // Preserve user/account that were hydrated by /auth/me on app load —
    // setSession would otherwise reset them to null for refresh-only updates.
    state.setSession({
      token: r.data.accessToken,
      refreshToken: r.data.refreshToken,
      user: state.user,
      account: state.account,
    });
    return r.data.accessToken as string;
  } catch {
    state.logout();
    return null;
  }
}

api.interceptors.response.use(
  (r) => r,
  async (err: AxiosError) => {
    const original = err.config as
      | (InternalAxiosRequestConfig & { _retry?: boolean })
      | undefined;
    const status = err.response?.status;
    const url = original?.url ?? '';

    const isAuthBypass = AUTH_BYPASS.some((p) => url.includes(p));
    const shouldTryRefresh =
      status === 401 && original && !original._retry && !isAuthBypass;

    if (!shouldTryRefresh) {
      // Auth-bypass endpoints that 401 (e.g. login with bad password) should
      // just propagate the error. Other 401s (refresh endpoint failed, no
      // refresh token at all, etc.) hard-logout and bounce to /login.
      if (
        status === 401 &&
        !isAuthBypass &&
        typeof window !== 'undefined' &&
        !window.location.pathname.startsWith('/login')
      ) {
        useAuth.getState().logout();
        window.location.href = '/login';
      }
      return Promise.reject(err);
    }

    if (!refreshInFlight) {
      refreshInFlight = doRefresh().finally(() => {
        refreshInFlight = null;
      });
    }
    const newToken = await refreshInFlight;

    if (!newToken) {
      // Refresh failed; doRefresh() already cleared the session. Bounce to
      // /login once (skip if we're already there to avoid a navigation loop).
      if (
        typeof window !== 'undefined' &&
        !window.location.pathname.startsWith('/login')
      ) {
        window.location.href = '/login';
      }
      return Promise.reject(err);
    }

    original._retry = true;
    original.headers = original.headers ?? {};
    original.headers.Authorization = `Bearer ${newToken}`;
    return api(original);
  },
);

export function apiErrMessage(e: unknown): string {
  const ax = e as AxiosError<{ message?: unknown }>;
  const m = ax?.response?.data?.message;
  if (Array.isArray(m)) return m.join('; ');
  if (typeof m === 'string') return m;
  // NestJS BadRequestException whose payload is a zod fieldErrors object,
  // e.g. { azureTenantId: ["String must contain at least 1 character(s)"], ... }
  if (m && typeof m === 'object') {
    const parts: string[] = [];
    for (const [field, errs] of Object.entries(m as Record<string, unknown>)) {
      const list = Array.isArray(errs)
        ? errs.filter((x): x is string => typeof x === 'string')
        : typeof errs === 'string'
          ? [errs]
          : [];
      if (list.length > 0) parts.push(`${field}: ${list.join(', ')}`);
    }
    if (parts.length > 0) return parts.join('; ');
  }
  return ax?.message || '请求失败';
}
