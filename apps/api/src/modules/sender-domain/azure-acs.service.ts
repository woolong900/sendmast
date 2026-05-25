import { Injectable, Logger } from '@nestjs/common';
import { CommunicationServiceManagementClient } from '@azure/arm-communication';
import { ClientSecretCredential } from '@azure/identity';
import type {
  SenderDomainDnsRecord,
  SenderDomainRecordKind,
  SenderDomainVerificationStates,
  SenderDomainVerificationStatus,
} from '@sendmast/shared';

interface AcsAccountForArm {
  azureTenantId: string;
  azureClientId: string;
  azureClientSecret: string;
  azureSubscriptionId: string;
  azureResourceGroup: string;
  azureEmailServiceName: string;
  azureCommunicationServiceName?: string | null;
}

export interface AzureSenderUsername {
  username: string;
  displayName?: string | null;
  azureResourceId?: string | null;
}

interface ClientCacheEntry {
  client: CommunicationServiceManagementClient;
  /** Identity tuple — flushed if any of these change. */
  key: string;
}

const RECORD_KINDS: SenderDomainRecordKind[] = ['Domain', 'SPF', 'DKIM', 'DKIM2', 'DMARC'];

/** Map our shared `SenderDomainRecordKind` → the SDK's verificationType / verificationRecords keys. */
const KIND_TO_SDK_VERIFY: Record<SenderDomainRecordKind, 'Domain' | 'SPF' | 'DKIM' | 'DKIM2' | 'DMARC'> =
  {
    Domain: 'Domain',
    SPF: 'SPF',
    DKIM: 'DKIM',
    DKIM2: 'DKIM2',
    DMARC: 'DMARC',
  };

@Injectable()
export class AzureAcsService {
  private readonly logger = new Logger(AzureAcsService.name);
  private readonly clients = new Map<string, ClientCacheEntry>();

  /**
   * Provision a new CustomerManaged domain on the AcsAccount's Email
   * Communication Service. Idempotent: re-creating an existing resource
   * just refreshes it. Returns the DNS records the customer needs to add.
   */
  async createDomain(
    acsAccount: AcsAccountForArm,
    domain: string,
  ): Promise<{ records: SenderDomainDnsRecord[] }> {
    const client = this.clientFor(acsAccount);
    const result = await client.domains.beginCreateOrUpdateAndWait(
      acsAccount.azureResourceGroup,
      acsAccount.azureEmailServiceName,
      domain,
      {
        location: 'global',
        domainManagement: 'CustomerManaged',
      },
      // Poll every 1s instead of the SDK's default ~2s so we catch the
      // "Succeeded" state sooner. Has no effect on Azure-side latency.
      { updateIntervalInMs: 1000 },
    );

    const vr = result.verificationRecords ?? {};
    const records: SenderDomainDnsRecord[] = [];
    for (const kind of RECORD_KINDS) {
      const r = (vr as Record<string, { type?: string; name?: string; value?: string; ttl?: number } | undefined>)[
        kind.toLowerCase()
      ];
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

    if (records.length === 0) {
      // Surfaced to API via sender-domain.service. Don't mention the upstream
      // provider name in the message — admin can still see the full Azure
      // error with stack trace in server logs (Logger above).
      throw new Error('域名注册未返回验证记录,请联系管理员检查通道配置。');
    }
    return { records };
  }

  /**
   * Trigger Azure's DNS verification check for one record. The SDK call
   * starts a long-running operation; we fire-and-forget, since the actual
   * verification result is read back via `getStates`.
   */
  async initiateVerification(
    acsAccount: AcsAccountForArm,
    domain: string,
    kind: SenderDomainRecordKind,
  ): Promise<void> {
    const client = this.clientFor(acsAccount);
    try {
      await client.domains.beginInitiateVerification(
        acsAccount.azureResourceGroup,
        acsAccount.azureEmailServiceName,
        domain,
        { verificationType: KIND_TO_SDK_VERIFY[kind] },
      );
    } catch (err) {
      this.logger.warn(
        `initiateVerification failed for ${domain}/${kind}: ${(err as Error).message}`,
      );
    }
  }

  /** Read the current verificationStates map from Azure. */
  async getStates(
    acsAccount: AcsAccountForArm,
    domain: string,
  ): Promise<SenderDomainVerificationStates> {
    const client = this.clientFor(acsAccount);
    const result = await client.domains.get(
      acsAccount.azureResourceGroup,
      acsAccount.azureEmailServiceName,
      domain,
    );
    const vs = (result.verificationStates ?? {}) as Record<
      string,
      { status?: string; lastDetectedTimestamp?: Date | string } | undefined
    >;

    const out: SenderDomainVerificationStates = {};
    for (const kind of RECORD_KINDS) {
      const s = vs[kind.toLowerCase()];
      if (!s) continue;
      out[kind] = {
        status: normaliseStatus(s.status),
        lastDetectedAt: s.lastDetectedTimestamp
          ? new Date(s.lastDetectedTimestamp).toISOString()
          : null,
      };
    }
    return out;
  }

  /**
   * Add the EmailService domain to the CommunicationService's `linkedDomains`
   * array. Without this Azure rejects EmailClient.send with 401 even after
   * the domain is DNS-verified. Idempotent: re-adding an already-linked
   * domain is a no-op (we read current list first and dedupe).
   *
   * Throws if `acsAccount.azureCommunicationServiceName` is missing — the
   * caller should validate before calling.
   */
  async linkDomain(acsAccount: AcsAccountForArm, domain: string): Promise<void> {
    if (!acsAccount.azureCommunicationServiceName) {
      // Defensive: caller (sender-domain.service.ts) already gates on this
      // field, so we shouldn't ever reach here. Generic message in case it
      // does leak to the client via some future code path.
      throw new Error('发送通道配置不完整,请联系管理员。');
    }
    const client = this.clientFor(acsAccount);
    const domainResourceId = this.domainResourceId(acsAccount, domain);

    const current = await client.communicationServices.get(
      acsAccount.azureResourceGroup,
      acsAccount.azureCommunicationServiceName,
    );
    const existing = current.linkedDomains ?? [];
    if (existing.some((id) => id.toLowerCase() === domainResourceId.toLowerCase())) {
      return;
    }
    const next = [...existing, domainResourceId];
    await client.communicationServices.update(
      acsAccount.azureResourceGroup,
      acsAccount.azureCommunicationServiceName,
      { linkedDomains: next },
    );
  }

  /**
   * Remove the EmailService domain from CommunicationService.linkedDomains.
   * Best-effort: any failure is logged and swallowed so DB cleanup can
   * still proceed when deleting a domain.
   */
  async unlinkDomain(acsAccount: AcsAccountForArm, domain: string): Promise<void> {
    if (!acsAccount.azureCommunicationServiceName) return;
    const client = this.clientFor(acsAccount);
    const domainResourceId = this.domainResourceId(acsAccount, domain).toLowerCase();
    try {
      const current = await client.communicationServices.get(
        acsAccount.azureResourceGroup,
        acsAccount.azureCommunicationServiceName,
      );
      const next = (current.linkedDomains ?? []).filter(
        (id) => id.toLowerCase() !== domainResourceId,
      );
      if (next.length === (current.linkedDomains?.length ?? 0)) return;
      await client.communicationServices.update(
        acsAccount.azureResourceGroup,
        acsAccount.azureCommunicationServiceName,
        { linkedDomains: next },
      );
    } catch (err) {
      this.logger.warn(
        `unlinkDomain failed for ${domain}: ${(err as Error).message} (continuing)`,
      );
    }
  }

  /** List sender usernames currently registered on a domain in Azure. */
  async listSenderUsernames(
    acsAccount: AcsAccountForArm,
    domain: string,
  ): Promise<AzureSenderUsername[]> {
    const client = this.clientFor(acsAccount);
    const out: AzureSenderUsername[] = [];
    for await (const r of client.senderUsernames.listByDomains(
      acsAccount.azureResourceGroup,
      acsAccount.azureEmailServiceName,
      domain,
    )) {
      if (!r.username) continue;
      out.push({
        username: r.username,
        displayName: r.displayName,
        azureResourceId: r.id ?? null,
      });
    }
    return out;
  }

  /** Create or update a sender username (e.g. `donotreply`) on a domain. */
  async createSenderUsername(
    acsAccount: AcsAccountForArm,
    domain: string,
    username: string,
    displayName?: string,
  ): Promise<AzureSenderUsername> {
    const client = this.clientFor(acsAccount);
    const r = await client.senderUsernames.createOrUpdate(
      acsAccount.azureResourceGroup,
      acsAccount.azureEmailServiceName,
      domain,
      username,
      { username, displayName },
    );
    return {
      username: r.username ?? username,
      displayName: r.displayName,
      azureResourceId: r.id ?? null,
    };
  }

  /** Delete a sender username; best-effort, logs on failure. */
  async deleteSenderUsername(
    acsAccount: AcsAccountForArm,
    domain: string,
    username: string,
  ): Promise<void> {
    const client = this.clientFor(acsAccount);
    try {
      await client.senderUsernames.delete(
        acsAccount.azureResourceGroup,
        acsAccount.azureEmailServiceName,
        domain,
        username,
      );
    } catch (err) {
      this.logger.warn(
        `deleteSenderUsername failed for ${domain}/${username}: ${(err as Error).message} (continuing)`,
      );
    }
  }

  /** Best-effort delete; logs and swallows so DB cleanup can proceed. */
  async deleteDomain(acsAccount: AcsAccountForArm, domain: string): Promise<void> {
    const client = this.clientFor(acsAccount);
    try {
      await client.domains.beginDeleteAndWait(
        acsAccount.azureResourceGroup,
        acsAccount.azureEmailServiceName,
        domain,
      );
    } catch (err) {
      this.logger.warn(
        `deleteDomain failed for ${domain}: ${(err as Error).message} (continuing)`,
      );
    }
  }

  /**
   * Full ARM resource id for an EmailService domain. Used as the value
   * we push into CommunicationService.linkedDomains.
   */
  private domainResourceId(acsAccount: AcsAccountForArm, domain: string): string {
    return (
      `/subscriptions/${acsAccount.azureSubscriptionId}` +
      `/resourceGroups/${acsAccount.azureResourceGroup}` +
      `/providers/Microsoft.Communication/emailServices/${acsAccount.azureEmailServiceName}` +
      `/domains/${domain}`
    );
  }

  private clientFor(acct: AcsAccountForArm): CommunicationServiceManagementClient {
    const key = [
      acct.azureTenantId,
      acct.azureClientId,
      acct.azureClientSecret,
      acct.azureSubscriptionId,
    ].join('|');
    const cached = this.clients.get(acct.azureSubscriptionId);
    if (cached && cached.key === key) return cached.client;

    const credential = new ClientSecretCredential(
      acct.azureTenantId,
      acct.azureClientId,
      acct.azureClientSecret,
    );
    const client = new CommunicationServiceManagementClient(credential, acct.azureSubscriptionId);
    this.clients.set(acct.azureSubscriptionId, { client, key });
    return client;
  }
}

function normaliseStatus(raw: string | undefined): SenderDomainVerificationStatus {
  switch (raw) {
    case 'NotStarted':
    case 'VerificationRequested':
    case 'VerificationFailed':
    case 'Verified':
    case 'CancellationRequested':
      return raw;
    default:
      return 'Unknown';
  }
}
