import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ReferralService } from './referral.service';
import type { ReferralLookupView } from '@sendmast/shared';

/**
 * Public — used by the /signup page to render the "由 XXX 推荐" banner
 * before the user submits. Resolves a referral code to its channel's
 * display name. Returns `{ code, name: '' }` on unknown/disabled codes
 * so the frontend can hide the banner without erroring out — we never
 * want a stale link to block signup.
 */
@ApiTags('public/referral')
@Controller('public/referral')
export class ReferralPublicController {
  constructor(private readonly svc: ReferralService) {}

  @Get(':code')
  async lookup(@Param('code') code: string): Promise<ReferralLookupView> {
    const r = await this.svc.lookupByCode(code);
    return r ?? { code: code.trim().toUpperCase(), name: '' };
  }
}
