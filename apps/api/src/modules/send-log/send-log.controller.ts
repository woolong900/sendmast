import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { SendLogService } from './send-log.service';
import { SendLogQuerySchema } from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('admin/send-logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/send-logs')
export class SendLogController {
  constructor(private readonly svc: SendLogService) {}

  @Get()
  list(@Query() query: unknown) {
    const r = SendLogQuerySchema.safeParse(query);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.list(r.data);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.detail(id);
  }
}
