import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { QuotaBillingService } from './quota-billing.service';
import { CreateQuotaOrderSchema } from '@sendmast/shared';
import { firstZodError } from '../../common/zod-error';

@ApiTags('quota-billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class QuotaBillingController {
  constructor(private readonly svc: QuotaBillingService) {}

  /** Public-to-the-tenant tier list. Hides inactive rows; admins see all
   *  via the admin endpoint. */
  @Get('quota-tiers')
  listTiers() {
    return this.svc.listActiveTiers();
  }

  @Post('quota-orders')
  async createOrder(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const r = CreateQuotaOrderSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(firstZodError(r.error));
    return this.svc.createOrder({
      accountId: user.accountId,
      userId: user.userId,
      tierId: r.data.tierId,
    });
  }

  @Get('quota-orders')
  listOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.listMyOrders(user.accountId);
  }

  /** Single-order lookup, used by the modal to poll a pending order's
   *  status while showing the QR code (every 2s until status flips to
   *  `paid` via the Airwallex webhook). */
  @Get('quota-orders/:providerOrderId')
  getOrder(
    @Param('providerOrderId') providerOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.getMyOrder(user.accountId, providerOrderId);
  }
}
