import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { ReferralService } from './referral.service';
import {
  CommissionExportQuerySchema,
  MonthSchema,
  ReferralChannelInputSchema,
  ReferralSettingInputSchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('admin/referral')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/referral')
export class ReferralAdminController {
  constructor(private readonly svc: ReferralService) {}

  // ---------- Channels --------------------------------------------------

  @Get('channels')
  listChannels() {
    return this.svc.listChannels();
  }

  @Post('channels')
  async createChannel(@Body() body: unknown) {
    const r = ReferralChannelInputSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.createChannel(r.data);
  }

  @Put('channels/:id')
  async updateChannel(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const r = ReferralChannelInputSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.updateChannel(id, r.data);
  }

  @Delete('channels/:id')
  async deleteChannel(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.svc.deleteChannel(id);
    return { ok: true };
  }

  // ---------- Settings (global rate %) ----------------------------------

  @Get('settings')
  getSettings() {
    return this.svc.getSettings();
  }

  @Put('settings')
  async updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = ReferralSettingInputSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.updateSettings(r.data.ratePercent, user.userId);
  }

  // ---------- Commissions -----------------------------------------------

  @Get('commissions/summary')
  async summary(@Query('month') month: string) {
    const r = MonthSchema.safeParse(month);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.monthlySummary(r.data);
  }

  @Get('commissions')
  async listCommissions(@Query('month') month: string, @Query('channelId') channelId?: string) {
    const r = MonthSchema.safeParse(month);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.listCommissions({
      month: r.data,
      channelId: channelId && channelId.trim() ? channelId : undefined,
    });
  }

  /**
   * CSV export of one month's commissions, optionally filtered to a
   * single channel. Two-section CSV: per-channel summary, then per-order
   * detail. UTF-8 BOM included so Excel opens it without garbling
   * Chinese (see ReferralService.exportCommissionsCsv).
   */
  @Get('commissions/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async export(@Query() query: unknown, @Res() res: Response) {
    const r = CommissionExportQuerySchema.safeParse(query);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    const csv = await this.svc.exportCommissionsCsv(r.data);
    const filename = `commissions-${r.data.month}${
      r.data.channelId ? `-${r.data.channelId.slice(0, 8)}` : ''
    }.csv`;
    res.header('Content-Disposition', `attachment; filename="${filename}"`).send(csv);
  }
}
