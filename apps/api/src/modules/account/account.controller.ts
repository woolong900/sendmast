import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { TenantQuotaView } from '@sendmast/shared';

@ApiTags('accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('accounts')
export class AccountController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me/quota')
  async myQuota(@CurrentUser() user: AuthenticatedUser): Promise<TenantQuotaView> {
    const acct = await this.prisma.account.findUnique({
      where: { id: user.accountId },
      select: { sendQuotaRemaining: true },
    });
    return { remaining: acct?.sendQuotaRemaining ?? 0 };
  }
}
