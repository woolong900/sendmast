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
import {
  ConnectShopyySchema,
  SHOP_AUTOMATION_TYPES,
  UpdateShopAutomationSchema,
  type ShopAutomationType,
} from '@sendmast/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { firstZodError } from '../../common/zod-error';
import { IntegrationsService } from './integrations.service';

@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('integrations/shopyy')
export class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  /** List this tenant's shopyy connections + whether the feature is configured. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.listConnections(user.accountId);
  }

  /**
   * Finish the authorize handshake and bind the store. The SPA posts the
   * `code` + `authorize_token_url` it received on the redirect callback page.
   */
  @Post('connect')
  connect(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const r = ConnectShopyySchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.connectShopyy(user.accountId, r.data);
  }

  /** The three fixed automations for a store (lazily created). */
  @Get(':id/automations')
  listAutomations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.listAutomations(user.accountId, id);
  }

  /** Store coupons for the abandoned-cart per-round coupon picker. */
  @Get(':id/coupons')
  listCoupons(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.listCoupons(user.accountId, id);
  }

  @Patch(':id/automations/:type')
  updateAutomation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('type') type: string,
    @Body() body: unknown,
  ) {
    if (!(SHOP_AUTOMATION_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException('未知的自动化类型');
    }
    const r = UpdateShopAutomationSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.updateAutomation(
      user.accountId,
      id,
      type as ShopAutomationType,
      r.data,
    );
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.disconnect(user.accountId, id);
  }
}
