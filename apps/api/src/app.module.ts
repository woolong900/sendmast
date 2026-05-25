import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateConfig } from './config/config-validation.schema';
import { PrismaModule } from './common/prisma/prisma.module';
import { AccountWriteInterceptor } from './common/guards/account-write.guard';
import { RedisModule } from './common/redis/redis.module';
import { ClickHouseModule } from './common/clickhouse/clickhouse.module';
import { S3Module } from './common/s3/s3.module';
import { QueueModule } from './common/queue/queue.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { AccountModule } from './modules/account/account.module';
import { SenderDomainModule } from './modules/sender-domain/sender-domain.module';
import { AcsAccountModule } from './modules/acs-account/acs-account.module';
import { ContactModule } from './modules/contact/contact.module';
import { ImportModule } from './modules/import/import.module';
import { UploadModule } from './modules/upload/upload.module';
import { TemplateModule } from './modules/template/template.module';
import { CampaignModule } from './modules/campaign/campaign.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { SendLogModule } from './modules/send-log/send-log.module';
import { SystemMailModule } from './modules/system-mail/system-mail.module';
import { CustomTagModule } from './modules/custom-tag/custom-tag.module';
import { SegmentModule } from './modules/segment/segment.module';
import { QuotaBillingModule } from './modules/quota-billing/quota-billing.module';
import { FxModule } from './modules/fx/fx.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      validate: validateConfig,
    }),
    // Global IP-level rate limit. Default bucket = 240 req/min per IP.
    // Sensitive endpoints in AuthController narrow this via @Throttle().
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 240 }]),
    PrismaModule,
    RedisModule,
    ClickHouseModule,
    S3Module,
    QueueModule,
    HealthModule,
    AuthModule,
    AccountModule,
    SenderDomainModule,
    AcsAccountModule,
    ContactModule,
    ImportModule,
    UploadModule,
    TemplateModule,
    CampaignModule,
    TrackingModule,
    AnalyticsModule,
    DashboardModule,
    WebhookModule,
    SendLogModule,
    SystemMailModule,
    CustomTagModule,
    SegmentModule,
    FxModule,
    QuotaBillingModule,
  ],
  providers: [
    // Global IP-level rate limit (default 240 req/min, see ThrottlerModule
    // config above). Sensitive auth endpoints additionally narrow this via
    // their own @Throttle() decorator.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Globally enforce account suspension on every write. Implemented as an
    // interceptor (not a guard) so it runs AFTER per-route JwtAuthGuard has
    // populated req.user — see file for full rationale.
    { provide: APP_INTERCEPTOR, useClass: AccountWriteInterceptor },
  ],
})
export class AppModule {}
