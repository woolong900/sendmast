import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  AssignAcsAccountsSchema,
  SetAccountRoleSchema,
  SetAccountStatusSchema,
  SetTenantQuotaSchema,
} from '@sendmast/shared';
import type { AccountRole, AdminAccountView, AssignedAcsAccountView } from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('admin/accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/accounts')
export class AccountAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(): Promise<AdminAccountView[]> {
    const rows = await this.prisma.account.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        acsAccounts: {
          include: { acsAccount: { select: { id: true, name: true, status: true } } },
          orderBy: { createdAt: 'asc' },
        },
        // Owner email = first member with role=owner. There can be more in
        // theory but signup only ever creates one; if a second is added
        // later we just show the first by createdAt asc.
        members: {
          where: { role: 'owner' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          include: { user: { select: { email: true, isPlatformAdmin: true } } },
        },
        _count: { select: { senderDomains: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      acsAccounts: r.acsAccounts.map(
        (l): AssignedAcsAccountView => ({
          id: l.acsAccount.id,
          name: l.acsAccount.name,
          status: l.acsAccount.status as 'active' | 'suspended' | 'retired',
          isPrimary: l.isPrimary,
        }),
      ),
      senderDomainCount: r._count.senderDomains,
      sendQuotaRemaining: r.sendQuotaRemaining,
      status: r.status,
      activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
      suspendedAt: r.suspendedAt ? r.suspendedAt.toISOString() : null,
      suspendedReason: r.suspendedReason,
      ownerEmail: r.members[0]?.user.email ?? null,
      role: deriveAccountRole(r.members[0]?.user.isPlatformAdmin ?? false, r.isCollaborator),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Admin override for tenant lifecycle. The state machine documented on
   * SetAccountStatusSchema; we don't enforce transitions here (admin is
   * trusted) but we DO write the audit timestamps so the operations team
   * can later reconstruct who/when. The acting admin's id isn't recorded
   * yet — defer until we add a proper audit log table.
   */
  @Patch(':id/status')
  async setStatus(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const r = SetAccountStatusSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));

    const data: {
      status: 'pending_activation' | 'active' | 'suspended';
      activatedAt?: Date | null;
      suspendedAt?: Date | null;
      suspendedReason?: string | null;
    } = { status: r.data.status };

    if (r.data.status === 'active') {
      // Mark activation timestamp if not already set; clear suspension fields
      // so a future "Suspended? — see reason" tooltip doesn't show stale text.
      const existing = await this.prisma.account.findUnique({
        where: { id },
        select: { activatedAt: true },
      });
      if (!existing) throw new BadRequestException('账号不存在');
      if (!existing.activatedAt) data.activatedAt = new Date();
      data.suspendedAt = null;
      data.suspendedReason = null;
    } else if (r.data.status === 'suspended') {
      data.suspendedAt = new Date();
      data.suspendedReason = r.data.reason ?? null;
    } else {
      // pending_activation: clear suspension fields so the banner UI is
      // consistent. activatedAt is NOT cleared (preserves history).
      data.suspendedAt = null;
      data.suspendedReason = null;
    }

    await this.prisma.account.update({ where: { id }, data });
    // Bust the Redis status cache so the suspended/activated state takes
    // effect on the very next request from this tenant (worst case before
    // this line: 60s TTL of stale 'active' lets a suspended user keep writing).
    await this.auth.invalidateAccountStatusCache(id);
    return { ok: true, status: r.data.status };
  }

  @Patch(':id/quota')
  async setQuota(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const r = SetTenantQuotaSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    await this.prisma.account.update({
      where: { id },
      data: { sendQuotaRemaining: r.data.remaining },
    });
    return { ok: true, remaining: r.data.remaining };
  }

  /**
   * Set a tenant's role. The three roles map onto two flags:
   *   - platform_admin → owner user(s) isPlatformAdmin=true, account collaborator
   *   - collaborator    → owner user(s) isPlatformAdmin=false, collaborator=true
   *   - tenant          → owner user(s) isPlatformAdmin=false, collaborator=false
   * 普通租户 (tenant) gets the softened analytics view; the other two see real
   * deliverability data. Promoting to platform_admin grants GLOBAL admin to the
   * owner — admin-only (this controller is PlatformAdminGuard'd).
   */
  @Patch(':id/role')
  async setRole(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const r = SetAccountRoleSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    const role = r.data.role;

    const owners = await this.prisma.accountUser.findMany({
      where: { accountId: id, role: 'owner' },
      select: { userId: true },
    });
    if (role === 'platform_admin' && owners.length === 0) {
      throw new BadRequestException('该租户没有所有者用户,无法设为平台管理员');
    }

    const isPlatformAdmin = role === 'platform_admin';
    const isCollaborator = role === 'platform_admin' || role === 'collaborator';

    await this.prisma.$transaction([
      this.prisma.account.update({ where: { id }, data: { isCollaborator } }),
      this.prisma.user.updateMany({
        where: { id: { in: owners.map((o) => o.userId) } },
        data: { isPlatformAdmin },
      }),
    ]);
    return { ok: true, role };
  }

  /**
   * "代登录" — mint a fresh JWT pair that puts the calling Platform Admin
   * inside the target tenant's workspace. All existing tenant-scoped routes
   * (campaigns / contacts / segments / templates / sender-domains / orders /
   * custom-tags / …) Just Work because they resolve `accountId` from
   * `req.user.accountId`. The frontend swaps tokens, refetches `/auth/me`,
   * and the new payload's `impersonation` field triggers the yellow banner.
   */
  @Post(':id/impersonate')
  async impersonate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.auth.impersonate(
      user.userId,
      id,
      req.headers['user-agent'],
      requestIp(req),
    );
  }

  @Get(':id/acs-accounts')
  async listAcsAccounts(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AssignedAcsAccountView[]> {
    const links = await this.prisma.accountAcsAccount.findMany({
      where: { accountId: id },
      include: { acsAccount: { select: { id: true, name: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return links.map((l) => ({
      id: l.acsAccount.id,
      name: l.acsAccount.name,
      status: l.acsAccount.status as 'active' | 'suspended' | 'retired',
      isPrimary: l.isPrimary,
    }));
  }

  /**
   * Replace a tenant's full ACS assignment set in one shot. The set must
   * reference existing, active ACS accounts; exactly one is primary (unless the
   * set is empty). An ACS account cannot be removed while the tenant still has
   * sender domains bound to it (those domains' sends would break).
   */
  @Put(':id/acs-accounts')
  async assignAcsAccounts(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const r = AssignAcsAccountsSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    const { acsAccountIds, primaryAcsAccountId } = r.data;

    const account = await this.prisma.account.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!account) throw new BadRequestException('账号不存在');

    const ids = Array.from(new Set(acsAccountIds));
    if (ids.length > 0) {
      const found = await this.prisma.acsAccount.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true },
      });
      if (found.length !== ids.length) {
        throw new BadRequestException('包含不存在的 ACS 账号');
      }
      const inactive = found.find((a) => a.status !== 'active');
      if (inactive) {
        throw new BadRequestException(`ACS 账号 ${inactive.id} 当前状态为 ${inactive.status}，无法分配`);
      }
    }

    // Guard: any ACS account currently bound to this tenant's sender domains
    // must remain in the new set, otherwise those domains can no longer send.
    const boundDomains = await this.prisma.senderDomain.findMany({
      where: { accountId: id },
      select: { acsAccountId: true },
      distinct: ['acsAccountId'],
    });
    const boundAcsIds = new Set(boundDomains.map((d) => d.acsAccountId));
    const removed = [...boundAcsIds].filter((acsId) => !ids.includes(acsId));
    if (removed.length > 0) {
      throw new BadRequestException(
        '无法移除仍有发件域名绑定的 ACS 账号，请先删除相关域名',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.accountAcsAccount.deleteMany({ where: { accountId: id } });
      if (ids.length > 0) {
        await tx.accountAcsAccount.createMany({
          data: ids.map((acsId) => ({
            accountId: id,
            acsAccountId: acsId,
            isPrimary: acsId === primaryAcsAccountId,
          })),
        });
      }
    });
    return { ok: true };
  }
}

function requestIp(req: Request): string | undefined {
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xff || req.ip;
}

/** Precedence: platform_admin > collaborator > tenant. */
function deriveAccountRole(ownerIsPlatformAdmin: boolean, isCollaborator: boolean): AccountRole {
  if (ownerIsPlatformAdmin) return 'platform_admin';
  if (isCollaborator) return 'collaborator';
  return 'tenant';
}
