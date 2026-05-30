/**
 * One-shot: import Azure-provisioned sender domains into SendMast for a tenant.
 * Usage (on server, inside api container):
 *   node /app/scripts/bulk-import-sender-domains.mjs
 *
 * Requires DATABASE_URL in env (api container has it).
 */
import { resolveTxt } from 'node:dns/promises';
import { PrismaClient } from '@prisma/client';
import { CommunicationServiceManagementClient } from '@azure/arm-communication';
import { ClientSecretCredential } from '@azure/identity';

const ACCOUNT_ID = '3efcd5bc-af9c-4aa5-83a3-8e2507f89008'; // woolong900@gmail.com / DMOAL
const ACS_ACCOUNT_ID = '8c78bd06-e0d2-4f06-a307-801a86ca218a';
const SENDER_USERNAME = 'postal';
const SENDER_DISPLAY_NAME = 'U.S. Postal';

const DOMAINS = [
  'jokdg.com',
  'mxwik.com',
  'lucsh.com',
  'yttfz.com',
  'nwrpo.com',
  'swywk.com',
  'oecsk.com',
  'kgngs.com',
  'zhxub.com',
  'wuhfs.com',
  'tsfcg.com',
  'mszpn.com',
  'wpepo.com',
  'clwah.com',
  'kxkml.com',
  'lvycw.com',
  'fozfu.com',
  'mofkh.com',
];

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
  return [
    ...records,
    {
      kind: 'DMARC',
      type: 'TXT',
      name: '_dmarc',
      value: DEFAULT_DMARC,
      ttl: 3600,
    },
  ];
}

function parseStates(vs) {
  const out = {};
  for (const kind of RECORD_KINDS) {
    const s = vs?.[kind.toLowerCase()];
    if (!s) continue;
    out[kind] = {
      status: s.status ?? 'Unknown',
      lastDetectedAt: s.lastDetectedTimestamp
        ? new Date(s.lastDetectedTimestamp).toISOString()
        : null,
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
  const published = await detectDmarcPublished(domain);
  return {
    ...states,
    DMARC: {
      status: published ? 'Verified' : 'VerificationFailed',
      lastDetectedAt: now,
    },
  };
}

function clientFor(acs) {
  const credential = new ClientSecretCredential(
    acs.azureTenantId,
    acs.azureClientId,
    acs.azureClientSecret,
  );
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
  const current = await client.communicationServices.get(
    acs.azureResourceGroup,
    acs.azureCommunicationServiceName,
  );
  const existing = current.linkedDomains ?? [];
  if (existing.some((id) => id.toLowerCase() === rid.toLowerCase())) return true;
  await client.communicationServices.update(
    acs.azureResourceGroup,
    acs.azureCommunicationServiceName,
    { linkedDomains: [...existing, rid] },
  );
  return true;
}

async function importDomain(client, acs, domain) {
  const existing = await prisma.senderDomain.findFirst({
    where: { accountId: ACCOUNT_ID, domain },
  });
  if (existing) {
    console.log(`SKIP ${domain}: already in SendMast (${existing.status})`);
    return { domain, action: 'skipped' };
  }

  let azureDomain;
  try {
    azureDomain = await client.domains.get(
      acs.azureResourceGroup,
      acs.azureEmailServiceName,
      domain,
    );
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
  const allVerified =
    recordKinds.length > 0 && recordKinds.every((k) => states[k]?.status === 'Verified');

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

  // Sender username
  const existingUser = await prisma.senderUsername.findFirst({
    where: { senderDomainId: row.id, username: SENDER_USERNAME },
  });
  if (!existingUser) {
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
  }

  console.log(
    `OK ${domain}: status=${allVerified ? 'verified' : 'pending'}, postal@${domain}, linked=${!!linkedAt}`,
  );
  return { domain, action: 'imported', status: allVerified ? 'verified' : 'pending' };
}

async function main() {
  const acs = await prisma.acsAccount.findUnique({ where: { id: ACS_ACCOUNT_ID } });
  if (!acs) throw new Error('ACS account not found');
  const account = await prisma.account.findUnique({ where: { id: ACCOUNT_ID } });
  if (!account) throw new Error('Tenant account not found');

  console.log(`Importing ${DOMAINS.length} domains → ${account.name} (${ACCOUNT_ID})`);
  const client = clientFor(acs);
  const results = [];
  for (const domain of DOMAINS) {
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
