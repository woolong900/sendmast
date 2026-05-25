import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { ContactService } from './contact.service';
import {
  BatchContactActionSchema,
  CreateContactSchema,
  ListContactsQuerySchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('contacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('contacts')
export class ContactController {
  constructor(private readonly svc: ContactService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const r = ListContactsQuerySchema.safeParse(query);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.listContacts(user.accountId, r.data);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = CreateContactSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.createContact(user.accountId, r.data);
  }

  @Post('batch')
  batch(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = BatchContactActionSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.batchAction(user.accountId, r.data);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.deleteContact(user.accountId, id);
  }
}
