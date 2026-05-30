import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AzureAcsService } from './azure-acs.service';
import { ensureDmarcRecord } from './dmarc-record';
import type {
  SenderDomainDnsRecord,
  SenderDomainRecordKind,
  SenderDomainStatus,
  SenderDomainVerificationStates,
  SenderDomainView,
  SenderUsernameView,
} from '@sendmast/shared';

type SenderUsernameRow = {
  id: string;
  username: string;
  displayName: string | null;
  createdAt: Date;
};

@Injectable()
export class SenderDomainService {
  private readonly logger = new Logger(SenderDomainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly azure: AzureAcsService,
  ) {}

  async list(accountId: string): Promise<SenderDomainView[]> {
    const rows = await this.prisma.senderDomain.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      include: { senderUsernames: { orderBy: { createdAt: 'asc' } } },
    });
    return rows.map((r) => this.toView(r, r.senderUsernames));
  }

  async get(accountId: string, id: string): Promise<SenderDomainView> {
    const row = await this.prisma.senderDomain.findFirst({
      where: { id, accountId },
      include: { senderUsernames: { orderBy: { createdAt: 'asc' } } },
    });
    if (!row) throw new NotFoundException('域名不存在');
    return this.toView(row, row.senderUsernames);
  }

  /**
   * Create a sender domain. The Azure ARM call to create the domain takes
   * 20–40s (long-running operation + DKIM key generation). We don't make
   * the user wait synchronously — instead we:
   *   1. insert a row with `status='provisioning'` and an empty record list,
   *   2. fire-and-forget the Azure call,
   *   3. when Azure returns we patch the row with records + `status='pending'`
   *      (or `status='failed'` on error).
   * The front-end polls `GET /api/sender-domains/:id` until records appear.
   */
  async create(accountId: string, domain: string): Promise<SenderDomainView> {
    const cleaned = domain.toLowerCase().trim();
    const exists = await this.prisma.senderDomain.findFirst({
      where: { accountId, domain: cleaned },
    });
    if (exists) throw new BadRequestException('该域名已添加');

    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      include: { defaultAcsAccount: true },
    });
    if (!account) throw new NotFoundException('工作区不存在');
    const acsAccount = account.defaultAcsAccount;
    if (!acsAccount) {
      throw new BadRequestException(
        'No default ACS account assigned to this tenant. Contact a platform administrator.',
      );
    }
    if (acsAccount.status !== 'active') {
      throw new BadRequestException(
        `Default ACS account ${acsAccount.name} is ${acsAccount.status}.`,
      );
    }

    const row = await this.prisma.senderDomain.create({
      data: {
        accountId,
        acsAccountId: acsAccount.id,
        domain: cleaned,
        verificationRecords: [] as unknown as Prisma.InputJsonValue,
        status: 'provisioning',
      },
    });

    void this.provisionInBackground(row.id, acsAccount, cleaned);

    return this.toView(row);
  }

  /**
   * Long-running Azure call. Runs detached from the HTTP request. Caller is
   * responsible for the placeholder DB row already existing.
   */
  private async provisionInBackground(
    rowId: string,
    acsAccount: Parameters<AzureAcsService['createDomain']>[0],
    domain: string,
  ): Promise<void> {
    try {
      const { records: azureRecords } = await this.azure.createDomain(acsAccount, domain);
      const records = ensureDmarcRecord(azureRecords);
      await this.prisma.senderDomain.update({
        where: { id: rowId },
        data: {
          verificationRecords: records as unknown as Prisma.InputJsonValue,
          status: 'pending',
        },
      });
    } catch (err) {
      this.logger.error(
        `Azure provisioning failed for domain ${domain} (row ${rowId}): ${(err as Error).message}`,
        (err as Error).stack,
      );
      await this.prisma.senderDomain
        .update({
          where: { id: rowId },
          data: { status: 'failed' },
        })
        .catch((updateErr) =>
          this.logger.error(
            `Failed to mark row ${rowId} as failed: ${(updateErr as Error).message}`,
          ),
        );
    }
  }

  /**
   * Refresh verification states from Azure. If a record hasn't been
   * verification-requested yet, kick off `initiateVerification` for it.
   */
  async verify(accountId: string, id: string): Promise<SenderDomainView> {
    const row = await this.prisma.senderDomain.findFirst({
      where: { id, accountId },
      include: { acsAccount: true },
    });
    if (!row) throw new NotFoundException('域名不存在');
    if (row.status === 'provisioning') {
      throw new BadRequestException('系统正在配置该域名，请稍候再试。');
    }
    if (row.status === 'failed') {
      throw new BadRequestException('域名配置失败，请删除后重新添加。');
    }

    // Always include platform-mandatory DMARC even when Azure didn't return it.
    const storedRecords = (row.verificationRecords as unknown as SenderDomainDnsRecord[]) ?? [];
    const records = ensureDmarcRecord(storedRecords);
    if (records.length !== storedRecords.length) {
      await this.prisma.senderDomain.update({
        where: { id: row.id },
        data: { verificationRecords: records as unknown as Prisma.InputJsonValue },
      });
    }
    const recordKinds: SenderDomainRecordKind[] = records.map((r) => r.kind);

    // First refresh — see what's currently in flight.
    const states = await this.azure.getStates(row.acsAccount, row.domain);

    // Kick off verification for any record still in NotStarted / Unknown.
    // Verifications take a while on Azure's side, so this is fire-and-forget.
    const toInitiate = recordKinds.filter((k) => {
      const s = states[k]?.status;
      return !s || s === 'NotStarted' || s === 'Unknown' || s === 'VerificationFailed';
    });
    await Promise.all(
      toInitiate.map((k) => this.azure.initiateVerification(row.acsAccount, row.domain, k)),
    );

    // Re-read states after kicking things off so the response reflects
    // requests that just transitioned to VerificationRequested.
    const refreshed = toInitiate.length > 0
      ? await this.azure.getStates(row.acsAccount, row.domain)
      : states;

    // "All verified" means every DNS record we showed the user is verified.
    // Using `recordKinds` (not RECORD_KINDS) keeps this aligned with the UI:
    // if the UI shows 4 green "已生效" badges, status flips to 'verified'.
    const allVerified =
      recordKinds.length > 0 && recordKinds.every((k) => refreshed[k]?.status === 'Verified');

    // Once a domain is fully DNS-verified we auto-link it to the
    // AcsAccount's CommunicationService — there's no UX value in making
    // the user click an extra button. Best-effort: a missing
    // azureCommunicationServiceName or an Azure-side failure is logged
    // but doesn't fail the verify call (the domain is still considered
    // verified — they just won't be able to send until link succeeds).
    let linkedAt: Date | null = row.linkedAt;
    if (allVerified && !linkedAt && row.acsAccount.azureCommunicationServiceName) {
      try {
        await this.azure.linkDomain(row.acsAccount, row.domain);
        linkedAt = new Date();
      } catch (err) {
        this.logger.warn(
          `Auto-link failed for ${row.domain}: ${(err as Error).message}`,
        );
      }
    }

    const updated = await this.prisma.senderDomain.update({
      where: { id: row.id },
      data: {
        verificationStates: refreshed as unknown as Prisma.InputJsonValue,
        lastCheckedAt: new Date(),
        status: allVerified ? 'verified' : 'pending',
        verifiedAt: allVerified ? row.verifiedAt ?? new Date() : row.verifiedAt,
        linkedAt,
      },
      include: { senderUsernames: { orderBy: { createdAt: 'asc' } } },
    });
    return this.toView(updated, updated.senderUsernames);
  }

  async listSenderUsernames(accountId: string, id: string): Promise<SenderUsernameView[]> {
    const row = await this.prisma.senderDomain.findFirst({
      where: { id, accountId },
      include: { senderUsernames: { orderBy: { createdAt: 'asc' } } },
    });
    if (!row) throw new NotFoundException('域名不存在');
    return row.senderUsernames.map((u) => this.toUsernameView(u, row.domain));
  }

  /**
   * Add a sender username (e.g. `donotreply`) to the domain. The full
   * "from" address becomes `${username}@${domain}`. Azure requires the
   * domain to be verified (and ideally linked) before sends will succeed,
   * but the SDK accepts createOrUpdate at any time after provisioning.
   */
  async addSenderUsername(
    accountId: string,
    id: string,
    username: string,
    displayName?: string,
  ): Promise<SenderUsernameView> {
    const row = await this.prisma.senderDomain.findFirst({
      where: { id, accountId },
      include: { acsAccount: true },
    });
    if (!row) throw new NotFoundException('域名不存在');
    if (row.status !== 'verified') {
      throw new BadRequestException('请先完成域名验证后再添加寄件人地址。');
    }

    const cleanedUsername = username.trim().toLowerCase();
    const existing = await this.prisma.senderUsername.findFirst({
      where: { senderDomainId: row.id, username: cleanedUsername },
    });
    if (existing) {
      throw new BadRequestException(`寄件人 ${cleanedUsername}@${row.domain} 已存在。`);
    }

    const azureResult = await this.azure.createSenderUsername(
      row.acsAccount,
      row.domain,
      cleanedUsername,
      displayName,
    );

    const created = await this.prisma.senderUsername.create({
      data: {
        senderDomainId: row.id,
        username: cleanedUsername,
        displayName: displayName ?? null,
        azureResourceId: azureResult.azureResourceId,
      },
    });
    return this.toUsernameView(created, row.domain);
  }

  async removeSenderUsername(
    accountId: string,
    domainId: string,
    usernameId: string,
  ): Promise<void> {
    const row = await this.prisma.senderDomain.findFirst({
      where: { id: domainId, accountId },
      include: { acsAccount: true },
    });
    if (!row) throw new NotFoundException('域名不存在');
    const u = await this.prisma.senderUsername.findFirst({
      where: { id: usernameId, senderDomainId: row.id },
    });
    if (!u) return;

    await this.azure.deleteSenderUsername(row.acsAccount, row.domain, u.username);
    await this.prisma.senderUsername.deleteMany({ where: { id: u.id } });
  }

  async remove(accountId: string, id: string): Promise<void> {
    const row = await this.prisma.senderDomain.findFirst({
      where: { id, accountId },
      include: { acsAccount: true },
    });
    if (!row) return;

    // Unlink first so the domain isn't referenced by the CommunicationService
    // when Azure runs the delete LRO. Best-effort — failures are logged and
    // we still proceed with the domain delete.
    await this.azure.unlinkDomain(row.acsAccount, row.domain);

    // Azure delete is a long-running operation. If the user clicks twice (or
    // we get racy concurrent calls) Azure rejects the second one with
    // "Another DELETE in progress" — that's fine, the first one will finish,
    // so we treat that case as "already deleting on Azure" and proceed.
    await this.azure.deleteDomain(row.acsAccount, row.domain);

    // Use deleteMany to be idempotent: if a concurrent request already
    // removed the row, this returns count=0 instead of throwing P2025.
    // Both calls then converge on the same final state and the client gets
    // a clean 200 either way. SenderUsername rows cascade with the domain.
    await this.prisma.senderDomain.deleteMany({ where: { id: row.id } });
  }

  private toView(
    row: {
      id: string;
      domain: string;
      acsAccountId: string;
      status: SenderDomainStatus;
      verificationRecords: Prisma.JsonValue;
      verificationStates: Prisma.JsonValue | null;
      lastCheckedAt: Date | null;
      verifiedAt: Date | null;
      linkedAt: Date | null;
    },
    senderUsernames: SenderUsernameRow[] = [],
  ): SenderDomainView {
    const records = ensureDmarcRecord(
      (row.verificationRecords as unknown as SenderDomainDnsRecord[]) ?? [],
    );
    const states = (row.verificationStates as unknown as SenderDomainVerificationStates) ?? {};
    // A domain marked verified before we enforced DMARC must re-verify DMARC
    // before the UI treats it as fully ready (step 3+ in the add-domain wizard).
    let status = row.status;
    if (status === 'verified' && states.DMARC?.status !== 'Verified') {
      status = 'pending';
    }
    return {
      id: row.id,
      domain: row.domain,
      acsAccountId: row.acsAccountId,
      status,
      records,
      states,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      linkedAt: row.linkedAt?.toISOString() ?? null,
      senderUsernames: senderUsernames.map((u) => this.toUsernameView(u, row.domain)),
    };
  }

  private toUsernameView(u: SenderUsernameRow, domain: string): SenderUsernameView {
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      fullAddress: `${u.username}@${domain}`,
      createdAt: u.createdAt.toISOString(),
    };
  }
}
