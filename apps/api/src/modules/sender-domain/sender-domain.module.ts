import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SenderDomainController } from './sender-domain.controller';
import { SenderDomainAdminController } from './sender-domain-admin.controller';
import { SenderDomainService } from './sender-domain.service';
import { AzureAcsService } from './azure-acs.service';
import { CloudflareEmailService } from './cloudflare-email.service';
import { MailgunService } from './mailgun.service';
import { ResendService } from './resend.service';
import { SendGridService } from './sendgrid.service';
import { SesService } from './ses.service';

@Module({
  imports: [AuthModule],
  controllers: [SenderDomainController, SenderDomainAdminController],
  providers: [
    SenderDomainService,
    AzureAcsService,
    CloudflareEmailService,
    MailgunService,
    ResendService,
    SendGridService,
    SesService,
  ],
  exports: [
    SenderDomainService,
    AzureAcsService,
    CloudflareEmailService,
    MailgunService,
    ResendService,
    SendGridService,
    SesService,
  ],
})
export class SenderDomainModule {}
