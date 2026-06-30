import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailChannelController } from './email-channel.controller';
import { EmailChannelService } from './email-channel.service';

@Module({
  imports: [AuthModule],
  controllers: [EmailChannelController],
  providers: [EmailChannelService],
  exports: [EmailChannelService],
})
export class EmailChannelModule {}
