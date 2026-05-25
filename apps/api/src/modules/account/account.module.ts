import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountAdminController } from './account-admin.controller';
import { AccountController } from './account.controller';

@Module({
  imports: [AuthModule],
  controllers: [AccountAdminController, AccountController],
})
export class AccountModule {}
