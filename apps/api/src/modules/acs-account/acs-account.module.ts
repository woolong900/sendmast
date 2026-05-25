import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AcsAccountController } from './acs-account.controller';
import { AcsAccountService } from './acs-account.service';

@Module({
  imports: [AuthModule],
  controllers: [AcsAccountController],
  providers: [AcsAccountService],
  exports: [AcsAccountService],
})
export class AcsAccountModule {}
