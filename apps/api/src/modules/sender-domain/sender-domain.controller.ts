import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { SenderDomainService } from './sender-domain.service';
import {
  CreateSenderDomainSchema,
  CreateSenderUsernameSchema,
  UpdateRecipientBlockPatternsSchema,
  UpdateSenderUsernameSchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('sender-domains')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sender-domains')
export class SenderDomainController {
  constructor(private readonly svc: SenderDomainService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.list(user.accountId);
  }

  // Declared before the `:id` param route so the literal path wins (otherwise
  // ParseUUIDPipe would reject "email-channels" as a non-UUID).
  @Get('email-channels')
  emailChannels(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.listEmailChannels(user.accountId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.get(user.accountId, id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = CreateSenderDomainSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.create(user.accountId, r.data.domain, r.data.emailChannelId);
  }

  @Post(':id/verify')
  verify(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.verify(user.accountId, id);
  }

  @Patch(':id/recipient-block-patterns')
  updateRecipientBlockPatterns(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const r = UpdateRecipientBlockPatternsSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.updateRecipientBlockPatterns(user.accountId, id, r.data.patterns);
  }

  @Get(':id/usernames')
  listUsernames(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.listSenderUsernames(user.accountId, id);
  }

  @Post(':id/usernames')
  addUsername(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const r = CreateSenderUsernameSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.addSenderUsername(user.accountId, id, r.data.username, r.data.displayName);
  }

  /** Change a sender address's display name (synced to ACS when applicable). */
  @Patch(':id/usernames/:usernameId')
  updateUsername(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('usernameId', new ParseUUIDPipe()) usernameId: string,
    @Body() body: unknown,
  ) {
    const r = UpdateSenderUsernameSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.updateSenderUsername(user.accountId, id, usernameId, r.data.displayName);
  }

  @Delete(':id/usernames/:usernameId')
  removeUsername(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('usernameId', new ParseUUIDPipe()) usernameId: string,
  ) {
    return this.svc.removeSenderUsername(user.accountId, id, usernameId);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.remove(user.accountId, id);
  }
}
