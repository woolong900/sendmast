import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SendLogController } from './send-log.controller';
import { SendLogService } from './send-log.service';

@Module({
  imports: [AuthModule],
  controllers: [SendLogController],
  providers: [SendLogService],
})
export class SendLogModule {}
