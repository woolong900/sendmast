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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CampaignService } from './campaign.service';
import {
  CreateCampaignSchema,
  ListCampaignsQuerySchema,
  ListRecipientsQuerySchema,
  UpdateCampaignSchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('campaigns')
export class CampaignController {
  constructor(private readonly svc: CampaignService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const r = ListCampaignsQuerySchema.safeParse(query);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.list(user.accountId, r.data);
  }

  @Get('stats/status-counts')
  statusCounts(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.statusCounts(user.accountId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.get(user.accountId, id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = CreateCampaignSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.create(user.accountId, r.data);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const r = UpdateCampaignSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.update(user.accountId, id, r.data);
  }

  @Post(':id/send')
  send(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.send(user.accountId, id);
  }

  @Post(':id/pause')
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.pause(user.accountId, id);
  }

  @Post(':id/resume')
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.resume(user.accountId, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.cancel(user.accountId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.remove(user.accountId, id);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.duplicate(user.accountId, id);
  }

  @Get(':id/recipients')
  listRecipients(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: unknown,
  ) {
    const r = ListRecipientsQuerySchema.safeParse(query);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.listRecipients(user.accountId, id, r.data);
  }
}
