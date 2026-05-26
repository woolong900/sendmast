import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReferralService } from './referral.service';
import { ReferralAdminController } from './referral.admin.controller';
import { ReferralPublicController } from './referral.public.controller';

@Module({
  // AuthModule for JwtAuthGuard + PlatformAdminGuard wiring. forwardRef
  // because AuthModule re-imports ReferralModule so AuthService can
  // resolve a signup-time referral code to a channel id.
  imports: [forwardRef(() => AuthModule)],
  controllers: [ReferralAdminController, ReferralPublicController],
  providers: [ReferralService],
  // Exported so QuotaBillingService can invoke `recordCommissionForPaidOrder`
  // from inside the Shouqianba notify handler, AND so AuthService can
  // resolve referral codes during signup.
  exports: [ReferralService],
})
export class ReferralModule {}
