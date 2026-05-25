import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { SenderDomainService } from './sender-domain.service';
import { CreateSenderDomainSchema, CreateSenderUsernameSchema } from '@sendmast/shared';
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

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.get(user.accountId, id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = CreateSenderDomainSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.create(user.accountId, r.data.domain);
  }

  @Post(':id/verify')
  verify(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.verify(user.accountId, id);
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
