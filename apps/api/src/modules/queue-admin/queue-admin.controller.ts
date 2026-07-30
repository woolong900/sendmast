import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { QueueService } from '../../common/queue/queue.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';

@ApiTags('admin/queues')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/queues')
export class QueueAdminController {
  constructor(private readonly queue: QueueService) {}

  @Get()
  list() {
    return this.queue.overview();
  }
}
