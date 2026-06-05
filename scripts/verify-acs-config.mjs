/**
 * One-shot: verify an ACS account's Azure configuration is usable —
 * authenticates with the stored service principal, reads the Email Service +
 * its domains, and reads the Communication Service (the resource used to link
 * domains for sending). Read-only.
 *
 * Usage (inside api container, from /app/apps/api):
 *   node ./verify-acs-config.mjs <ACS_ACCOUNT_ID>
 */
import { PrismaClient } from '@prisma/client';
import { CommunicationServiceManagementClient } from '@azure/arm-communication';
import { ClientSecretCredential } from '@azure/identity';

const ACS_ACCOUNT_ID = process.argv[2];
if (!ACS_ACCOUNT_ID) {
  console.error('usage: node verify-acs-config.mjs <ACS_ACCOUNT_ID>');
  process.exit(2);
}
const prisma = new PrismaClient();

async function main() {
  const acs = await prisma.acsAccount.findUnique({ where: { id: ACS_ACCOUNT_ID } });
  if (!acs) throw new Error('ACS account not found in DB');

  const checks = [];
  const ok = (label, detail) => checks.push(`  [OK]   ${label}${detail ? ' — ' + detail : ''}`);
  const fail = (label, detail) => checks.push(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);

  console.log(`ACS=${acs.name}`);
  console.log(`  subscription=${acs.azureSubscriptionId}`);
  console.log(`  resourceGroup=${acs.azureResourceGroup}`);
  console.log(`  emailService=${acs.azureEmailServiceName}`);
  console.log(`  communicationService=${acs.azureCommunicationServiceName}`);
  console.log(`  tenantId=${acs.azureTenantId}`);
  console.log(`  clientId=${acs.azureClientId}\n`);

  const credential = new ClientSecretCredential(acs.azureTenantId, acs.azureClientId, acs.azureClientSecret);
  const client = new CommunicationServiceManagementClient(credential, acs.azureSubscriptionId);

  // 1. Email Service read
  try {
    const es = await client.emailServices.get(acs.azureResourceGroup, acs.azureEmailServiceName);
    ok('Email Service read', `provisioningState=${es.provisioningState}, location=${es.location}`);
  } catch (e) {
    fail('Email Service read', e.message);
  }

  // 2. List domains under Email Service
  let domains = [];
  try {
    for await (const d of client.domains.listByEmailServiceResource(acs.azureResourceGroup, acs.azureEmailServiceName)) {
      const name = d.name ?? d.id?.split('/').pop();
      if (name && name !== 'AzureManagedDomain') domains.push(name);
    }
    ok('List domains', `${domains.length} custom domain(s): ${domains.join(', ') || '(none)'}`);
  } catch (e) {
    fail('List domains', e.message);
  }

  // 3. Communication Service read + linked domains
  if (acs.azureCommunicationServiceName) {
    try {
      const cs = await client.communicationServices.get(acs.azureResourceGroup, acs.azureCommunicationServiceName);
      ok('Communication Service read', `provisioningState=${cs.provisioningState}, linkedDomains=${(cs.linkedDomains ?? []).length}`);
    } catch (e) {
      fail('Communication Service read', e.message);
    }
  } else {
    fail('Communication Service', 'azureCommunicationServiceName is empty');
  }

  console.log('Checks:');
  console.log(checks.join('\n'));
  const failed = checks.filter((c) => c.includes('[FAIL]')).length;
  console.log(`\n${failed === 0 ? 'RESULT: configuration OK ✅' : `RESULT: ${failed} check(s) FAILED ❌`}`);
}

main()
  .catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
