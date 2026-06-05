/**
 * One-shot: re-verify specific pending domains for a tenant. Re-reads Azure
 * verification states, checks the customer-managed DMARC record in public DNS,
 * and (if everything is verified) links the domain to the ACS CommunicationService
 * and flips the SendMast row to `verified`.
 *
 * Usage (inside api container, from /app/apps/api):
 *   node ./reverify-acs-domains.mjs <ACS_ACCOUNT_ID> <TENANT_ACCOUNT_ID> <domain> [<domain> ...]
 */
import { resolveTxt } from 'node:dns/promises';
import { PrismaClient } from '@prisma/client';
import { CommunicationServiceManagementClient } from '@azure/arm-communication';
import { ClientSecretCredential } from '@azure/identity';

const ACS_ACCOUNT_ID = process.argv[2];
const ACCOUNT_ID = process.argv[3];
const DOMAINS = process.argv.slice(4);
if (!ACS_ACCOUNT_ID || !ACCOUNT_ID || DOMAINS.length === 0) {
  console.error('usage: node reverify-acs-domains.mjs <ACS_ACCOUNT_ID> <TENANT_ACCOUNT_ID> <domain> [...]');
  process.exit(2);
}

const RECORD_KINDS = ['Domain', 'SPF', 'DKIM', 'DKIM2', 'DMARC'];
const prisma = new PrismaClient();

function parseStates(vs) {
  const out = {};
  for (const kind of RECORD_KINDS) {
    const s = vs?.[kind.toLowerCase()];
    if (!s) continue;
    out[kind] = {
      status: s.status ?? 'Unknown',
      lastDetectedAt: s.lastDetectedTimestamp ? new Date(s.lastDetectedTimestamp).toISOString() : null,
    };
  }
  return out;
}

async function dmarcPublished(domain) {
  try {
    const rows = await resolveTxt(`_dmarc.${domain}`);
    return rows.some((chunks) => /^v=DMARC1/i.test(chunks.join('').trim()));
  } catch {
    return false;
  }
}

function clientFor(acs) {
  const credential = new ClientSecretCredential(acs.azureTenantId, acs.azureClientId, acs.azureClientSecret);
  return new CommunicationServiceManagementClient(credential, acs.azureSubscriptionId);
}

function domainResourceId(acs, domain) {
  return (
    `/subscriptions/${acs.azureSubscriptionId}` +
    `/resourceGroups/${acs.azureResourceGroup}` +
    `/providers/Microsoft.Communication/emailServices/${acs.azureEmailServiceName}` +
    `/domains/${domain}`
  );
}

async function linkDomain(client, acs, domain) {
  if (!acs.azureCommunicationServiceName) return false;
  const rid = domainResourceId(acs, domain);
  const current = await client.communicationServices.get(acs.azureResourceGroup, acs.azureCommunicationServiceName);
  const existing = current.linkedDomains ?? [];
  if (existing.some((id) => id.toLowerCase() === rid.toLowerCase())) return true;
  await client.communicationServices.update(acs.azureResourceGroup, acs.azureCommunicationServiceName, {
    linkedDomains: [...existing, rid],
  });
  return true;
}

async function reverify(client, acs, domain) {
  const row = await prisma.senderDomain.findFirst({ where: { accountId: ACCOUNT_ID, acsAccountId: ACS_ACCOUNT_ID, domain } });
  if (!row) {
    console.error(`FAIL ${domain}: not found for tenant under this ACS`);
    return;
  }
  const records = (row.verificationRecords ?? []).map((r) => r.kind);

  let states = parseStates((await client.domains.get(acs.azureResourceGroup, acs.azureEmailServiceName, domain)).verificationStates ?? {});
  const published = await dmarcPublished(domain);
  states = { ...states, DMARC: { status: published ? 'Verified' : 'VerificationFailed', lastDetectedAt: new Date().toISOString() } };

  const allVerified = records.length > 0 && records.every((k) => states[k]?.status === 'Verified');

  let linkedAt = row.linkedAt;
  if (allVerified && !linkedAt) {
    try {
      if (await linkDomain(client, acs, domain)) linkedAt = new Date();
    } catch (err) {
      console.warn(`WARN ${domain}: link failed — ${err.message}`);
    }
  }

  await prisma.senderDomain.update({
    where: { id: row.id },
    data: {
      verificationStates: states,
      lastCheckedAt: new Date(),
      status: allVerified ? 'verified' : 'pending',
      verifiedAt: allVerified ? row.verifiedAt ?? new Date() : row.verifiedAt,
      linkedAt,
    },
  });

  console.log(`${domain}: dmarc=${published ? 'Verified' : 'Failed'}, status=${allVerified ? 'verified' : 'pending'}, linked=${!!linkedAt}`);
}

async function main() {
  const acs = await prisma.acsAccount.findUnique({ where: { id: ACS_ACCOUNT_ID } });
  if (!acs) throw new Error('ACS account not found');
  const client = clientFor(acs);
  for (const domain of DOMAINS) await reverify(client, acs, domain);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
