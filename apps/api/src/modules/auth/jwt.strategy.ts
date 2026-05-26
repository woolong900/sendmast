import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  sub: string;
  accountId: string;
  isPlatformAdmin?: boolean;
  /** Admin's own user id when this token was minted via "代登录". */
  impersonatedBy?: string;
}

export interface AuthenticatedUser {
  userId: string;
  accountId: string;
  isPlatformAdmin: boolean;
  /**
   * When non-null, the request is being served on behalf of `accountId` by a
   * Platform Admin (`impersonatedBy` = admin's user id). Lets downstream
   * code relax tenant-status gates and surface "代登录中" in audit/logs.
   */
  impersonatedBy: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    return {
      userId: payload.sub,
      accountId: payload.accountId,
      isPlatformAdmin: payload.isPlatformAdmin === true,
      impersonatedBy: payload.impersonatedBy ?? null,
    };
  }
}
