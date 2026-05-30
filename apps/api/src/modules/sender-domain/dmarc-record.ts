import type { SenderDomainDnsRecord } from '@sendmast/shared';

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
