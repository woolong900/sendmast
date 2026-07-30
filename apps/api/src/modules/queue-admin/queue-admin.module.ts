import { Module } from '@nestjs/common';
import { QueueAdminController } from './queue-admin.controller';

@Module({
  controllers: [QueueAdminController],
})
export class QueueAdminModule {}
