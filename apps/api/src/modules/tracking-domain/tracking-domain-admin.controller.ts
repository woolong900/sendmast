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
import {
  CreateTrackingDomainSchema,
  UpdateTrackingDomainSchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';
import { TrackingDomainService } from './tracking-domain.service';

@ApiTags('admin/tracking-domains')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/tracking-domains')
export class TrackingDomainAdminController {
  constructor(private readonly svc: TrackingDomainService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  async create(@Body() body: unknown) {
    const r = CreateTrackingDomainSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.create(r.data);
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const r = UpdateTrackingDomainSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.update(id, r.data);
  }

  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.svc.remove(id);
    return { ok: true };
  }
}
