import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { SystemMailService } from './system-mail.service';
import {
  SendTestMailSchema,
  SystemSmtpConfigInputSchema,
  UpdateNotificationTemplateSchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('admin/system-mail')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/system-mail')
export class SystemMailController {
  constructor(private readonly svc: SystemMailService) {}

  @Get('config')
  async getConfig() {
    return (await this.svc.getConfigView()) ?? { configured: false };
  }

  @Put('config')
  async upsertConfig(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const r = SystemSmtpConfigInputSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    await this.svc.upsertConfig(r.data, user.userId);
    return { ok: true };
  }

  @Post('test')
  async sendTest(@Body() body: unknown) {
    const r = SendTestMailSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    await this.svc.sendTest(r.data.to, r.data.templateCode);
    return { ok: true };
  }

  @Get('templates')
  listTemplates() {
    return this.svc.listTemplates();
  }

  @Get('templates/:code')
  getTemplate(@Param('code') code: string) {
    return this.svc.getTemplate(code);
  }

  @Patch('templates/:code')
  async updateTemplate(
    @Param('code') code: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const r = UpdateNotificationTemplateSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.updateTemplate(code, r.data, user.userId);
  }
}
