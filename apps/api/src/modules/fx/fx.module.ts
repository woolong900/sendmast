import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FxAdminController, FxController } from './fx.controller';
import { FxService } from './fx.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [FxController, FxAdminController],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
