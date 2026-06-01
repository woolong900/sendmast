import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { TenantQuotaView } from '@sendmast/shared';

/** Tenant-quota poll interval — admin top-ups and live burn-down during a send
 *  surface within this window without a manual page refresh. */
const QUOTA_POLL_MS = 30_000;

/**
 * Shared tenant-quota query. Every consumer uses the same ['me','quota'] key,
 * so TanStack dedupes them into a single request + cache. Centralising it here
 * removes the endpoint/interval that was copy-pasted across the TopBar,
 * dashboard, quota page and campaign wizard.
 */
export function useQuota() {
  return useQuery<TenantQuotaView>({
    queryKey: ['me', 'quota'],
    queryFn: async () => (await api.get('/api/accounts/me/quota')).data,
    refetchInterval: QUOTA_POLL_MS,
  });
}
