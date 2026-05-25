import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { SegmentService } from './segment.service';
import {
  CreateSegmentSchema,
  ListSegmentContactsQuerySchema,
  PreviewSegmentSchema,
  UpdateSegmentSchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('segments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('segments')
export class SegmentController {
  constructor(private readonly svc: SegmentService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.list(user.accountId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.get(user.accountId, id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = CreateSegmentSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.create(user.accountId, r.data);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const r = UpdateSegmentSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.update(user.accountId, id, r.data);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.remove(user.accountId, id);
  }

  /**
   * Non-persisting evaluation. Called by the editor's "实时预览" card with
   * a debounced 500ms delay as the user edits rules — cost equals one full
   * resolveContactIds run, so the FE must not call it on every keystroke.
   */
  @Post('preview')
  @HttpCode(200)
  preview(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = PreviewSegmentSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.preview(user.accountId, r.data.definition);
  }

  /** Recompute and persist cachedCount. Idempotent; safe to call repeatedly. */
  @Post(':id/refresh')
  @HttpCode(200)
  refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.refresh(user.accountId, id);
  }

  @Get(':id/contacts')
  contacts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: unknown,
  ) {
    const r = ListSegmentContactsQuerySchema.safeParse(query);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.listContacts(user.accountId, id, r.data);
  }
}
