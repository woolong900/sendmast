/**
 * One-shot: import ALL Azure-provisioned custom domains under an ACS account's
 * Email Service into a SendMast tenant, bound to that ACS account, each with a
 * `postal` / "U.S. Postal" sender username. Idempotent (skips domains already
 * present for the tenant). Excludes the shared `AzureManagedDomain`.
 *
 * Usage (inside api container, from /app/apps/api):
 *   node ./import-acs-domains.mjs <ACS_ACCOUNT_ID> <TENANT_ACCOUNT_ID>
 */
import { resolveTxt } from 'node:dns/promises';
import { PrismaClient } from '@prisma/client';
import { CommunicationServiceManagementClient } from '@azure/arm-communication';
import { ClientSecretCredential } from '@azure/identity';

const ACS_ACCOUNT_ID = process.argv[2];
const ACCOUNT_ID = process.argv[3];
const SENDER_USERNAME = 'postal';
const SENDER_DISPLAY_NAME = 'U.S. Postal';
if (!ACS_ACCOUNT_ID || !ACCOUNT_ID) {
  console.error('usage: node import-acs-domains.mjs <ACS_ACCOUNT_ID> <TENANT_ACCOUNT_ID>');
  process.exit(2);
}

const RECORD_KINDS = ['Domain', 'SPF', 'DKIM', 'DKIM2', 'DMARC'];
const DEFAULT_DMARC = 'v=DMARC1; p=none';
const prisma = new PrismaClient();

function parseVerificationRecords(vr) {
  const records = [];
  for (const kind of RECORD_KINDS) {
    const r = vr?.[kind.toLowerCase()];
    if (!r) continue;
    const type = (r.type ?? '').toUpperCase();
    records.push({
      kind,
      type: type === 'CNAME' ? 'CNAME' : 'TXT',
      name: r.name ?? '',
      value: r.value ?? '',
      ttl: r.ttl,
    });
  }
  return records;
}

function ensureDmarcRecord(records) {
  if (records.some((r) => r.kind === 'DMARC')) return records;
  return [...records, { kind: 'DMARC', type: 'TXT', name: '_dmarc', value: DEFAULT_DMARC, ttl: 3600 }];
}

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

async function detectDmarcPublished(domain) {
  try {
    const rows = await resolveTxt(`_dmarc.${domain}`);
    return rows.some((chunks) => /^v=DMARC1/i.test(chunks.join('').trim()));
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return false;
    throw err;
  }
}

async function applyDmarcDnsVerification(domain, states) {
  const now = new Date().toISOString();
  let published = false;
  try {
    published = await detectDmarcPublished(domain);
  } catch {
    published = false;
  }
  return { ...states, DMARC: { status: published ? 'Verified' : 'VerificationFailed', lastDetectedAt: now } };
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

async function importDomain(client, acs, domain) {
  const existing = await prisma.senderDomain.findFirst({ where: { accountId: ACCOUNT_ID, domain } });
  if (existing) {
    console.log(`SKIP ${domain}: already in SendMast (${existing.status})`);
    return { domain, action: 'skipped' };
  }

  let azureDomain;
  try {
    azureDomain = await client.domains.get(acs.azureResourceGroup, acs.azureEmailServiceName, domain);
  } catch (err) {
    console.error(`FAIL ${domain}: not found in Azure — ${err.message}`);
    return { domain, action: 'azure_missing' };
  }

  const records = ensureDmarcRecord(parseVerificationRecords(azureDomain.verificationRecords ?? {}));
  if (records.length === 0) {
    console.error(`FAIL ${domain}: Azure returned no verification records`);
    return { domain, action: 'no_records' };
  }

  let states = parseStates(azureDomain.verificationStates ?? {});
  states = await applyDmarcDnsVerification(domain, states);

  const recordKinds = records.map((r) => r.kind);
  const allVerified = recordKinds.length > 0 && recordKinds.every((k) => states[k]?.status === 'Verified');

  let linkedAt = null;
  if (allVerified) {
    try {
      if (await linkDomain(client, acs, domain)) linkedAt = new Date();
    } catch (err) {
      console.warn(`WARN ${domain}: link failed — ${err.message}`);
    }
  }

  const row = await prisma.senderDomain.create({
    data: {
      accountId: ACCOUNT_ID,
      acsAccountId: ACS_ACCOUNT_ID,
      domain,
      verificationRecords: records,
      verificationStates: states,
      status: allVerified ? 'verified' : 'pending',
      verifiedAt: allVerified ? new Date() : null,
      linkedAt,
      lastCheckedAt: new Date(),
    },
  });

  let userOk = false;
  try {
    const azureUser = await client.senderUsernames.createOrUpdate(
      acs.azureResourceGroup,
      acs.azureEmailServiceName,
      domain,
      SENDER_USERNAME,
      { username: SENDER_USERNAME, displayName: SENDER_DISPLAY_NAME },
    );
    await prisma.senderUsername.create({
      data: {
        senderDomainId: row.id,
        username: SENDER_USERNAME,
        displayName: SENDER_DISPLAY_NAME,
        azureResourceId: azureUser.id ?? null,
      },
    });
    userOk = true;
  } catch (err) {
    console.warn(`WARN ${domain}: sender username create failed — ${err.message}`);
  }

  console.log(
    `OK ${domain}: status=${allVerified ? 'verified' : 'pending'}, linked=${!!linkedAt}, postal=${userOk}`,
  );
  return { domain, action: 'imported', status: allVerified ? 'verified' : 'pending' };
}

async function main() {
  const acs = await prisma.acsAccount.findUnique({ where: { id: ACS_ACCOUNT_ID } });
  if (!acs) throw new Error('ACS account not found');
  const account = await prisma.account.findUnique({ where: { id: ACCOUNT_ID } });
  if (!account) throw new Error('Tenant account not found');

  const client = clientFor(acs);
  const domains = [];
  for await (const d of client.domains.listByEmailServiceResource(acs.azureResourceGroup, acs.azureEmailServiceName)) {
    const name = d.name ?? d.id?.split('/').pop();
    if (!name || name === 'AzureManagedDomain') continue;
    domains.push(name);
  }

  console.log(`Importing ${domains.length} custom domain(s) → ${account.name} (${ACCOUNT_ID}) under ACS ${acs.name}\n`);
  const results = [];
  for (const domain of domains) {
    results.push(await importDomain(client, acs, domain));
  }
  console.log('\nSummary:');
  for (const r of results) console.log(`  ${r.domain}: ${r.action}${r.status ? ` (${r.status})` : ''}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
