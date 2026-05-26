import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TrackingDomainAdminController } from './tracking-domain-admin.controller';
import { TrackingDomainService } from './tracking-domain.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TrackingDomainAdminController],
  providers: [TrackingDomainService],
  exports: [TrackingDomainService],
})
export class TrackingDomainModule {}
