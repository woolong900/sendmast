import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SenderDomainController } from './sender-domain.controller';
import { SenderDomainAdminController } from './sender-domain-admin.controller';
import { SenderDomainService } from './sender-domain.service';
import { AzureAcsService } from './azure-acs.service';
import { MailgunService } from './mailgun.service';
import { ResendService } from './resend.service';

@Module({
  imports: [AuthModule],
  controllers: [SenderDomainController, SenderDomainAdminController],
  providers: [SenderDomainService, AzureAcsService, MailgunService, ResendService],
  exports: [SenderDomainService, AzureAcsService, MailgunService, ResendService],
})
export class SenderDomainModule {}
