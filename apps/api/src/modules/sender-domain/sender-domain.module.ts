import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SenderDomainController } from './sender-domain.controller';
import { SenderDomainAdminController } from './sender-domain-admin.controller';
import { SenderDomainService } from './sender-domain.service';
import { AzureAcsService } from './azure-acs.service';

@Module({
  imports: [AuthModule],
  controllers: [SenderDomainController, SenderDomainAdminController],
  providers: [SenderDomainService, AzureAcsService],
  exports: [SenderDomainService, AzureAcsService],
})
export class SenderDomainModule {}
