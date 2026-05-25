import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/platform-admin.guard';
import { FxService } from './fx.service';

@ApiTags('fx')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class FxController {
  constructor(private readonly fx: FxService) {}

  /** Current USD→CNY rate. Used by the upgrade modal to render the "1 USD ≈
   *  ¥X.XX" line and the live ¥ amount under each tier. Any logged-in user
   *  may read; the data is not sensitive. */
  @Get('fx/usd-cny')
  current() {
    return this.fx.getCurrentRate('USD', 'CNY');
  }
}

@ApiTags('admin/fx')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin/fx')
export class FxAdminController {
  constructor(private readonly fx: FxService) {}

  /** Force a fresh pull from Frankfurter and persist a new fx_rates row.
   *  Used by the "刷新汇率" button in the admin tier-management page. */
  @Post('refresh')
  async refresh() {
    return this.fx.refresh('manual', 'USD', 'CNY');
  }
}
