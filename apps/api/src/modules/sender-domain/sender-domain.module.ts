import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SenderDomainController } from './sender-domain.controller';
import { SenderDomainAdminController } from './sender-domain-admin.controller';
import { SenderDomainService } from './sender-domain.service';
import { AzureAcsService } from './azure-acs.service';
import { MailgunService } from './mailgun.service';

@Module({
  imports: [AuthModule],
  controllers: [SenderDomainController, SenderDomainAdminController],
  providers: [SenderDomainService, AzureAcsService, MailgunService],
  exports: [SenderDomainService, AzureAcsService, MailgunService],
})
export class SenderDomainModule {}
