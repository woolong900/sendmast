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
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { QuotaBillingService } from './quota-billing.service';
import {
  QuotaPricingTierInputSchema,
  ToggleQuotaPricingTierSchema,
} from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('admin/quota-tiers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/quota-tiers')
export class QuotaBillingAdminController {
  constructor(private readonly svc: QuotaBillingService) {}

  @Get()
  list() {
    return this.svc.listAllTiers();
  }

  @Post()
  async create(@Body() body: unknown) {
    const r = QuotaPricingTierInputSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.createTier(r.data);
  }

  @Put(':id')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const r = QuotaPricingTierInputSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.updateTier(id, r.data);
  }

  @Patch(':id/active')
  async toggle(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const r = ToggleQuotaPricingTierSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    await this.svc.toggleTier(id, r.data.active);
    return { ok: true };
  }

  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.svc.deleteTier(id);
    return { ok: true };
  }
}
