import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemMailController } from './system-mail.controller';
import { SystemMailService } from './system-mail.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [SystemMailController],
  providers: [SystemMailService],
  exports: [SystemMailService],
})
export class SystemMailModule {}
