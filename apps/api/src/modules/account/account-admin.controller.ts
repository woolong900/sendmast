import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
  AssignDefaultAcsAccountSchema,
  SetAccountStatusSchema,
  SetTenantQuotaSchema,
} from '@sendmast/shared';
import type { AdminAccountView } from '@sendmast/shared';
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
        defaultAcsAccount: { select: { id: true, name: true, status: true } },
        // Owner email = first member with role=owner. There can be more in
        // theory but signup only ever creates one; if a second is added
        // later we just show the first by createdAt asc.
        members: {
          where: { role: 'owner' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          include: { user: { select: { email: true } } },
        },
        _count: { select: { senderDomains: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      defaultAcsAccount: r.defaultAcsAccount
        ? {
            id: r.defaultAcsAccount.id,
            name: r.defaultAcsAccount.name,
            status: r.defaultAcsAccount.status as 'active' | 'suspended' | 'retired',
          }
        : null,
      senderDomainCount: r._count.senderDomains,
      sendQuotaRemaining: r.sendQuotaRemaining,
      status: r.status,
      activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
      suspendedAt: r.suspendedAt ? r.suspendedAt.toISOString() : null,
      suspendedReason: r.suspendedReason,
      ownerEmail: r.members[0]?.user.email ?? null,
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

  @Patch(':id/default-acs-account')
  async assignDefault(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const r = AssignDefaultAcsAccountSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));

    if (r.data.acsAccountId) {
      const acct = await this.prisma.acsAccount.findUnique({
        where: { id: r.data.acsAccountId },
        select: { id: true, status: true },
      });
      if (!acct) throw new BadRequestException('指定的 ACS 账号不存在');
      if (acct.status !== 'active') {
        throw new BadRequestException(`该 ACS 账号当前状态为 ${acct.status}，无法分配`);
      }
    }

    await this.prisma.account.update({
      where: { id },
      data: { defaultAcsAccountId: r.data.acsAccountId },
    });
    return { ok: true };
  }
}

function requestIp(req: Request): string | undefined {
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xff || req.ip;
}
