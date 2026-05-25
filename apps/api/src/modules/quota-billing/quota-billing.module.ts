import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FxModule } from '../fx/fx.module';
import { ShouqianbaService } from './shouqianba.service';
import { QuotaBillingService } from './quota-billing.service';
import { QuotaBillingController } from './quota-billing.controller';
import { QuotaBillingAdminController } from './quota-billing-admin.controller';
import { PaymentsController } from './payments.controller';

@Module({
  imports: [forwardRef(() => AuthModule), FxModule],
  controllers: [QuotaBillingController, QuotaBillingAdminController, PaymentsController],
  providers: [ShouqianbaService, QuotaBillingService],
  exports: [QuotaBillingService],
})
export class QuotaBillingModule {}
