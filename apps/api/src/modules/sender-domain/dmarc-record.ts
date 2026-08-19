import { Resolver, resolveTxt } from 'node:dns/promises';
import type { SenderDomainDnsRecord, SenderDomainVerificationStates } from '@sendmast/shared';

/** Platform default — monitor-only, no rua (user opted out). */
export const DEFAULT_DMARC_TXT_VALUE = 'v=DMARC1; p=none';
export const DEFAULT_DMARC_TTL = 3600;

/**
 * Azure ACS often omits DMARC from `verificationRecords` even though
 * `verificationStates.DMARC` exists and receivers (Yahoo, Gmail, …) expect
 * a `_dmarc` TXT. We always inject our standard record when Azure didn't
 * supply one so the UI shows five mandatory rows and verify() waits for it.
 */
export function ensureDmarcRecord(records: SenderDomainDnsRecord[]): SenderDomainDnsRecord[] {
  if (records.some((r) => r.kind === 'DMARC')) return records;
  return [
    ...records,
    {
      kind: 'DMARC',
      type: 'TXT',
      name: '_dmarc',
      value: DEFAULT_DMARC_TXT_VALUE,
      ttl: DEFAULT_DMARC_TTL,
    },
  ];
}

/**
 * Azure's initiateVerification/getStates for DMARC routinely stays
 * NotStarted even when `_dmarc.<domain>` is published correctly — Microsoft
 * documents DMARC as customer-managed via public DNS, not ACS-verified.
 * We therefore treat DMARC as verified when a public DNS TXT lookup finds
 * `v=DMARC1` (same check receivers perform).
 */
export async function detectDmarcPublished(domain: string): Promise<boolean> {
  const host = `_dmarc.${domain.toLowerCase().trim()}`;
  const resolvers = [
    { resolveTxt },
    publicResolver(['1.1.1.1', '1.0.0.1']),
    publicResolver(['8.8.8.8', '8.8.4.4']),
  ];
  let lastError: unknown = null;
  let sawNotFound = false;

  for (const resolver of resolvers) {
    try {
      const rows = await resolver.resolveTxt(host);
      if (rows.some((chunks) => /^v=DMARC1/i.test(chunks.join('').trim()))) return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENODATA' || code === 'ENOTFOUND') {
        sawNotFound = true;
        continue;
      }
      lastError = err;
    }
  }

  if (lastError && !sawNotFound) throw lastError;
  return false;
}

function publicResolver(servers: string[]): Pick<Resolver, 'resolveTxt'> {
  const resolver = new Resolver();
  resolver.setServers(servers);
  return resolver;
}

export async function applyDmarcDnsVerification(
  domain: string,
  states: SenderDomainVerificationStates,
): Promise<SenderDomainVerificationStates> {
  const published = await detectDmarcPublished(domain);
  const now = new Date().toISOString();
  if (published) {
    return { ...states, DMARC: { status: 'Verified', lastDetectedAt: now } };
  }
  // User clicked verify but public DNS doesn't see DMARC yet.
  return {
    ...states,
    DMARC: { status: 'VerificationFailed', lastDetectedAt: now },
  };
}
