import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

@ApiTags('admin/sender-domains')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/sender-domains')
export class SenderDomainAdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const rows = await this.prisma.senderDomain.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        account: { select: { id: true, name: true, slug: true } },
        acsAccount: { select: { id: true, name: true, status: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      status: r.status,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      account: r.account,
      acsAccount: r.acsAccount,
    }));
  }
}
