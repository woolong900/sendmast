import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { AuthenticatedUser } from './jwt.strategy';
import {
  ActivateSchema,
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  RefreshSchema,
  ResetPasswordSchema,
  SignupSchema,
  type ActivateInput,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type LoginInput,
  type RefreshInput,
  type ResetPasswordInput,
  type SignupInput,
} from '@sendmast/shared';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Sensitive endpoints: tight per-IP limits on top of the global 240/min
  // default. Anyone trying to brute-force credentials or spam our SMTP via
  // signup hits 429 fast. ttl unit is milliseconds.

  @Post('signup')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async signup(@Body() body: unknown, @Req() req: Request) {
    const input = parse(SignupSchema, body) as SignupInput;
    const tokens = await this.auth.signup(input, req.headers['user-agent'], requestIp(req));
    return tokens;
  }

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async login(@Body() body: unknown, @Req() req: Request) {
    const input = parse(LoginSchema, body) as LoginInput;
    const tokens = await this.auth.login(input, req.headers['user-agent'], requestIp(req));
    return tokens;
  }

  @Post('refresh')
  async refresh(@Body() body: unknown, @Req() req: Request) {
    const input = parse(RefreshSchema, body) as RefreshInput;
    return this.auth.refresh(input.refreshToken, req.headers['user-agent'], requestIp(req));
  }

  @Post('logout')
  async logout(@Body() body: unknown) {
    const input = parse(RefreshSchema, body) as RefreshInput;
    await this.auth.logout(input.refreshToken);
    return { ok: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.userId, user.accountId, user.impersonatedBy);
  }

  @Post('change-password')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parse(ChangePasswordSchema, body) as ChangePasswordInput;
    await this.auth.changePassword(user.userId, input.oldPassword, input.newPassword);
    return { ok: true };
  }

  /**
   * Public — kicks off the "forgot password" flow. Always returns 200 with
   * the same shape regardless of whether the email is registered, so callers
   * can't enumerate the user list. Internal logic generates a single-use
   * token, stores its hash, and mails a reset link via the system SMTP.
   */
  @Post('forgot-password')
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  async forgotPassword(@Body() body: unknown, @Req() req: Request) {
    const input = parse(ForgotPasswordSchema, body) as ForgotPasswordInput;
    await this.auth.requestPasswordReset(input.email, req.headers['user-agent'], requestIp(req));
    return { ok: true };
  }

  /** Public — used by the reset page to render "valid token / expired link". */
  @Get('reset-password/validate')
  async validateResetToken(@Query('token') token: string) {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('缺少 token 参数');
    }
    return this.auth.validateResetToken(token);
  }

  /** Public — submits the new password. */
  @Post('reset-password')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async resetPassword(@Body() body: unknown) {
    const input = parse(ResetPasswordSchema, body) as ResetPasswordInput;
    await this.auth.resetPassword(input.token, input.newPassword);
    return { ok: true };
  }

  /**
   * Public — redeems an activation token. The activation link in the email
   * lands on /activate?token=… in the web app, which calls this endpoint.
   * Returns `{ ok: false }` for any invalid/expired/used token (no error)
   * so the page can render a friendly "invalid link" state.
   */
  @Post('activate')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async activate(@Body() body: unknown) {
    const input = parse(ActivateSchema, body) as ActivateInput;
    return this.auth.activate(input.token);
  }

  /**
   * Authenticated — resends the activation email to the calling user. Used
   * by the in-app banner shown to pending_activation tenants. 60s rate limit
   * enforced server-side.
   */
  @Post('resend-activation')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  async resendActivation(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    await this.auth.resendActivation(user.userId, req.headers['user-agent'], requestIp(req));
    return { ok: true };
  }

  /**
   * Exit "代登录" — issues a fresh token pair pointing back at the calling
   * Platform Admin's home workspace. The endpoint is gated on
   * isPlatformAdmin (not on the impersonation flag) so the admin can call
   * it idempotently even if their session has already returned to its home
   * account; the worst case is a token rotation.
   */
  @Post('end-impersonation')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async endImpersonation(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.auth.endImpersonate(user.userId, req.headers['user-agent'], requestIp(req));
  }
}

function parse<T>(
  schema: {
    safeParse: (v: unknown) => {
      success: boolean;
      data?: T;
      error?: { errors: Array<{ path: (string | number)[]; message: string }> };
    };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const msg = result.error?.errors
      .map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`)
      .join('; ');
    throw new BadRequestException(msg ?? '请求参数不合法');
  }
  return result.data as T;
}

function requestIp(req: Request): string | undefined {
  return req.ip;
}
