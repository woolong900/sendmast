import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { SendLogService } from './send-log.service';
import { SendLogQuerySchema, SendLogSettingInputSchema } from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

@ApiTags('admin/send-logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/send-logs')
export class SendLogController {
  constructor(private readonly svc: SendLogService) {}

  @Get('settings')
  getSettings() {
    return this.svc.getSettings();
  }

  @Put('settings')
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = SendLogSettingInputSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.updateSettings(r.data.automationFinalHtmlLogEnabled, user.userId);
  }

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
