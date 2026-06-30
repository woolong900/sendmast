import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { EmailChannelService } from './email-channel.service';
import {
  CreateEmailChannelSchema,
  UpdateEmailChannelSchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('admin/email-channels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/email-channels')
export class EmailChannelController {
  constructor(private readonly svc: EmailChannelService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.get(id);
  }

  @Post()
  create(@Body() body: unknown) {
    const r = CreateEmailChannelSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.create(r.data);
  }

  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const r = UpdateEmailChannelSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.update(id, r.data);
  }

  @Delete(':id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/default')
  setDefault(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.setDefault(id);
  }
}
