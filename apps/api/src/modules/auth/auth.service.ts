import {
  Inject,
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { SystemMailService } from '../system-mail/system-mail.service';
import { ReferralService } from '../referral/referral.service';
import type {
  ActivateResponse,
  AuthTokens,
  LoginInput,
  MeResponse,
  ResetTokenValidateResponse,
  SignupInput,
} from '@sendmast/shared';

const ACCESS_TTL_FALLBACK = '15m';
const REFRESH_TTL_FALLBACK = '30d';

/** How long a password-reset token is valid after issuance. */
const RESET_TOKEN_TTL_HOURS = 1;
/** Minimum gap between consecutive forgot-password requests for the same user. */
const RESET_TOKEN_RATE_LIMIT_SECONDS = 60;
/** How long an account-activation token is valid. 24h gives users a relaxed window. */
const ACTIVATION_TOKEN_TTL_HOURS = 24;
/** Minimum gap between consecutive resend-activation requests for the same user. */
const ACTIVATION_RESEND_RATE_LIMIT_SECONDS = 60;

/**
 * Cache key + TTL for `accounts.status` lookups. Every authenticated write
 * goes through assertWritable, so without caching this is N writes/sec extra
 * PG load for a value that changes once per blue moon. 60s upper-bounds how
 * long a freshly-suspended tenant can keep writing in the worst case; admin
 * status mutations also actively DEL the key for near-instant enforcement.
 */
const ACCOUNT_STATUS_CACHE_PREFIX = 'acct:status:';
const ACCOUNT_STATUS_CACHE_TTL_SEC = 60;

interface CachedAccountStatus {
  status: 'pending_activation' | 'active' | 'suspended';
  suspendedReason: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @Inject(forwardRef(() => SystemMailService))
    private readonly systemMail: SystemMailService,
    @Inject(forwardRef(() => ReferralService))
    private readonly referral: ReferralService,
  ) {}

  // -------------------------------------------------------------------------
  // Account-status cache (Redis, 60s TTL)
  // -------------------------------------------------------------------------

  private statusKey(accountId: string): string {
    return `${ACCOUNT_STATUS_CACHE_PREFIX}${accountId}`;
  }

  /**
   * Cache-aside read of accounts.status + suspendedReason. On miss we fetch
   * the row from PG and SETEX it; on Redis transport errors we silently fall
   * through to PG so a Redis outage degrades to "every request hits PG"
   * (correctness preserved, just slower) instead of bringing the API down.
   */
  private async getAccountStatusCached(accountId: string): Promise<CachedAccountStatus | null> {
    const key = this.statusKey(accountId);
    try {
      const cached = await this.redis.client.get(key);
      if (cached) return JSON.parse(cached) as CachedAccountStatus;
    } catch (err) {
      this.logger.warn(`status cache GET failed for ${accountId}: ${(err as Error).message}`);
    }

    const row = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { status: true, suspendedReason: true },
    });
    if (!row) return null;

    const payload: CachedAccountStatus = {
      status: row.status,
      suspendedReason: row.suspendedReason,
    };
    try {
      await this.redis.client.set(key, JSON.stringify(payload), 'EX', ACCOUNT_STATUS_CACHE_TTL_SEC);
    } catch (err) {
      this.logger.warn(`status cache SET failed for ${accountId}: ${(err as Error).message}`);
    }
    return payload;
  }

  /**
   * Invalidate the cached status entry. Call this from EVERY code path that
   * mutates accounts.status — without it, suspension/activation will take up
   * to 60s to take effect. The DEL is best-effort; on Redis error we log and
   * move on (the TTL is the safety net).
   */
  async invalidateAccountStatusCache(accountId: string): Promise<void> {
    try {
      await this.redis.client.del(this.statusKey(accountId));
    } catch (err) {
      this.logger.warn(`status cache DEL failed for ${accountId}: ${(err as Error).message}`);
    }
  }

  async signup(input: SignupInput, ua?: string, ip?: string): Promise<AuthTokens> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictException('该邮箱已被注册');

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const slug = await this.uniqueSlug(input.accountName);

    // Resolve referral code BEFORE opening the txn — never blocks signup
    // (unknown/disabled codes resolve to null and just don't attribute).
    const referredByChannelId = await this.referral.resolveChannelIdForSignup(input.referralCode);

    const { user, account } = await this.prisma.$transaction(async (tx) => {
      // Inherit the platform-wide default ACS account (if one is set and
      // active) so the new tenant can immediately add sender domains
      // without an admin having to assign one manually.
      const platformDefault = await tx.acsAccount.findFirst({
        where: { isDefault: true, status: 'active' },
        select: { id: true },
      });
      const account = await tx.account.create({
        data: {
          name: input.accountName,
          slug,
          // Status defaults to `pending_activation` per Prisma schema; the
          // user gains read+limited-write access immediately, but campaign
          // create/start is gated until they redeem the activation link.
          defaultAcsAccountId: platformDefault?.id ?? null,
          referredByChannelId,
          referredAt: referredByChannelId ? new Date() : null,
        },
      });
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName ?? input.email.split('@')[0],
        },
      });
      await tx.accountUser.create({
        data: { accountId: account.id, userId: user.id, role: 'owner' },
      });
      return { user, account };
    });

    // Fire-and-forget: never block the signup HTTP response on SMTP latency
    // or failure. If it fails, the user can hit "resend activation" from
    // the in-app banner. Logged for ops.
    this.dispatchActivationEmail(user.id, user.email, user.displayName, ua, ip).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Activation mail to ${user.email} failed at signup: ${msg}`);
    });

    return this.issueTokens(user.id, account.id, user.isPlatformAdmin, ua, ip, null);
  }

  /**
   * Resend the activation email to the currently authenticated user. Throws
   * if the account is already active (no point) or if rate-limited.
   */
  async resendActivation(userId: string, ua?: string, ip?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { take: 1, include: { account: true } } },
    });
    if (!user) throw new UnauthorizedException();
    const account = user.memberships[0]?.account;
    if (!account) throw new UnauthorizedException('该账号未关联任何工作区');
    if (account.status === 'active') {
      throw new BadRequestException('账号已激活,无需重复操作。');
    }
    if (account.status === 'suspended') {
      // Suspended accounts can't self-rescue via resend — admin action only.
      throw new BadRequestException('账号已被封禁,请联系管理员。');
    }

    const recent = await this.prisma.emailVerificationToken.findFirst({
      where: {
        userId: user.id,
        createdAt: {
          gte: new Date(Date.now() - ACTIVATION_RESEND_RATE_LIMIT_SECONDS * 1000),
        },
      },
    });
    if (recent) {
      throw new BadRequestException(
        `操作过于频繁,请 ${ACTIVATION_RESEND_RATE_LIMIT_SECONDS} 秒后再试。`,
      );
    }

    await this.dispatchActivationEmail(user.id, user.email, user.displayName, ua, ip);
  }

  /**
   * Redeem an activation token. On success: marks token used, sets
   * `users.email_verified=true`, flips the user's account
   * `pending_activation` -> `active`. Idempotent for already-active accounts
   * (returns ok=true so the link works after a second click).
   */
  async activate(token: string): Promise<ActivateResponse> {
    const tokenHash = hashToken(token);
    const row = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      include: {
        user: { include: { memberships: { take: 1, include: { account: true } } } },
      },
    });
    if (!row) return { ok: false };
    if (row.usedAt) {
      // Reuse-of-already-redeemed case. If the account is active we treat
      // this as success (good UX for the second click); otherwise it's
      // invalid (token was used but account got rolled back somehow).
      const acc = row.user.memberships[0]?.account;
      if (acc?.status === 'active') return { ok: true, email: row.user.email };
      return { ok: false };
    }
    if (row.expiresAt < new Date()) return { ok: false };

    const accountId = row.user.memberships[0]?.account.id;
    if (!accountId) return { ok: false };

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: row.userId },
        data: { emailVerified: true },
      }),
      // updateMany so we don't trip if an admin already promoted the
      // tenant to active (rare but possible) — Prisma's update would
      // throw on no-row-found.
      this.prisma.account.updateMany({
        where: { id: accountId, status: 'pending_activation' },
        data: { status: 'active', activatedAt: new Date() },
      }),
    ]);

    // Drop any stale "pending_activation" entry so the next campaign-create
    // attempt from this tenant sees the freshly-active state immediately
    // instead of waiting for the 60s TTL.
    await this.invalidateAccountStatusCache(accountId);

    return { ok: true, email: row.user.email };
  }

  /**
   * Generate a fresh activation token, persist its hash, send the templated
   * email. Throws on SMTP failure so callers can react (signup uses .catch
   * to swallow; resendActivation lets it bubble so the user sees the
   * "mail not configured" error instead of silent loss).
   */
  private async dispatchActivationEmail(
    userId: string,
    email: string,
    displayName: string | null,
    ua?: string,
    ip?: string,
  ): Promise<void> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + ACTIVATION_TOKEN_TTL_HOURS * 3600 * 1000);

    await this.prisma.emailVerificationToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        requestedIp: ip ?? null,
        requestedUa: ua ?? null,
      },
    });

    const webBase = this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:5173';
    const activateUrl = `${webBase.replace(/\/$/, '')}/activate?token=${rawToken}`;

    await this.systemMail.sendTemplated('email_activation', email, {
      userName: displayName ?? email.split('@')[0],
      activateUrl,
      expiresInHours: String(ACTIVATION_TOKEN_TTL_HOURS),
    });
  }

  /**
   * Throws 403 if the tenant can't perform write operations right now.
   * Called by AccountWriteInterceptor for every mutation; reads from the
   * Redis status cache so the hot path is sub-millisecond and doesn't tax
   * the PG connection pool.
   */
  async assertWritable(accountId: string): Promise<void> {
    const a = await this.getAccountStatusCached(accountId);
    if (!a) throw new UnauthorizedException();
    if (a.status === 'suspended') {
      const reason = a.suspendedReason
        ? `账号已被封禁:${a.suspendedReason}`
        : '账号已被封禁,请联系管理员。';
      // 403 — the user IS authenticated, we just refuse the write.
      throw new ForbiddenException(reason);
    }
  }

  /**
   * Throws if the tenant is not fully active. Called by Campaign create /
   * start to gate the two ops that need a verified email (per product spec).
   */
  async assertActive(accountId: string): Promise<void> {
    const a = await this.getAccountStatusCached(accountId);
    if (!a) throw new UnauthorizedException();
    if (a.status === 'pending_activation') {
      throw new ForbiddenException('请先激活账号(点击注册邮箱里的激活链接)后再创建/发送活动。');
    }
    if (a.status === 'suspended') {
      throw new ForbiddenException('账号已被封禁,无法创建/发送活动。');
    }
  }

  async login(input: LoginInput, ua?: string, ip?: string): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { memberships: { take: 1 } },
    });
    if (!user) throw new UnauthorizedException('邮箱或密码不正确');
    const ok = await argon2.verify(user.passwordHash, input.password);
    if (!ok) throw new UnauthorizedException('邮箱或密码不正确');
    const accountId = user.memberships[0]?.accountId;
    if (!accountId) throw new UnauthorizedException('该账号未关联任何工作区');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.issueTokens(user.id, accountId, user.isPlatformAdmin, ua, ip, null);
  }

  async refresh(refreshToken: string, ua?: string, ip?: string): Promise<AuthTokens> {
    const payload = await this.verifyRefreshToken(refreshToken);

    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { memberships: { take: 1 } } } },
    });

    if (!stored || stored.revokedAt) throw new UnauthorizedException('登录已过期，请重新登录');
    if (stored.expiresAt < new Date()) throw new UnauthorizedException('登录已过期，请重新登录');
    if (stored.userId !== payload.sub) throw new UnauthorizedException('登录凭据无效');

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    // Carry impersonation context across rotation: if this refresh row was
    // minted via "代登录", the new pair stays in the same target tenant.
    // accountId on the row may be NULL for tokens issued before this feature
    // shipped — fall back to the user's first membership in that case.
    const accountId = stored.accountId ?? stored.user.memberships[0]?.accountId;
    if (!accountId) throw new UnauthorizedException('该账号未关联任何工作区');
    return this.issueTokens(
      stored.userId,
      accountId,
      stored.user.isPlatformAdmin,
      ua,
      ip,
      stored.impersonatedBy,
    );
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await this.prisma.refreshToken
      .update({
        where: { tokenHash },
        data: { revokedAt: new Date() },
      })
      .catch(() => {
        // already revoked / not found - silent
      });
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const ok = await argon2.verify(user.passwordHash, oldPassword);
    if (!ok) throw new BadRequestException('当前密码不正确');
    if (oldPassword === newPassword) {
      throw new BadRequestException('新密码不能与当前密码相同');
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    // Revoke all the user's other refresh tokens so existing sessions on
    // other devices are forced to re-login. The current session keeps
    // working until its access token expires (≤15m); the user can then
    // refresh and get a new pair tied to the current refresh row, which
    // we don't revoke here (we don't know which one it is from this
    // endpoint). Belt-and-suspenders: revoke all, the current session
    // will lose refresh ability — acceptable for a password rotation.
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  /**
   * "Forgot password" entry point. Always returns silently — caller must NOT
   * leak whether the email exists. Side effects (only when user exists):
   *   1. Throttle: skip if a token was issued in the last 60s.
   *   2. Generate a 32-byte random token, store its SHA-256 hash with 1h TTL.
   *   3. Render the password_reset template + send via system SMTP.
   * If SMTP is unconfigured we still return ok, but log the failure server-side.
   */
  async requestPasswordReset(email: string, ua?: string, ip?: string): Promise<void> {
    // Email is already normalized to lowercase+trim by the ForgotPasswordSchema.
    const user = await this.prisma.user.findUnique({
      where: { email },
    });
    if (!user) return; // anti-enumeration: silent no-op

    const recent = await this.prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        createdAt: { gte: new Date(Date.now() - RESET_TOKEN_RATE_LIMIT_SECONDS * 1000) },
      },
    });
    if (recent) {
      this.logger.warn(`forgot-password rate-limited for ${user.email}`);
      return;
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 3600 * 1000);

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        requestedIp: ip ?? null,
        requestedUa: ua ?? null,
      },
    });

    const webBase = this.config.get<string>('WEB_BASE_URL') ?? 'http://localhost:5173';
    const resetUrl = `${webBase.replace(/\/$/, '')}/reset-password?token=${rawToken}`;

    try {
      await this.systemMail.sendTemplated('password_reset', user.email, {
        userName: user.displayName ?? user.email.split('@')[0],
        resetUrl,
        expiresInHours: String(RESET_TOKEN_TTL_HOURS),
      });
    } catch (err) {
      // Never bubble SMTP errors to the caller (would leak that user exists +
      // that we tried to send). Just log and let the user re-request later.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Password-reset mail to ${user.email} failed: ${msg}`);
    }
  }

  async validateResetToken(token: string): Promise<ResetTokenValidateResponse> {
    const tokenHash = hashToken(token);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      return { ok: false };
    }
    return {
      ok: true,
      email: row.user.email,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(token);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });
    if (!row) throw new BadRequestException('链接无效');
    if (row.usedAt) throw new BadRequestException('链接已被使用');
    if (row.expiresAt < new Date()) throw new BadRequestException('链接已过期，请重新申请');

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });

    // Mark token used + update password + revoke all refresh tokens (force
    // re-login on every device) in one transaction.
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  async me(
    userId: string,
    accountId: string,
    impersonatedBy: string | null = null,
  ): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    // Impersonation path: admin acts as a member of an account they don't own.
    // The displayed identity (greeting on /dashboard, top-right avatar) should
    // match the workspace context — i.e. the tenant's owner, not the admin
    // who's puppeting them. The admin's own identity is surfaced in
    // `impersonation.originalUser` so the yellow banner stays accurate.
    //
    // `isPlatformAdmin` is also returned as false so the sidebar drops the
    // platform-admin group and route guards (RequirePlatformAdmin) keep the
    // admin scoped to tenant-side pages. The JWT still carries
    // `isPlatformAdmin=true` so the API enforces the right authorization on
    // /admin/* endpoints — this is purely a UI-presentation choice.
    if (impersonatedBy) {
      if (!user.isPlatformAdmin || impersonatedBy !== userId) {
        throw new UnauthorizedException();
      }
      const account = await this.prisma.account.findUnique({
        where: { id: accountId },
        include: {
          members: {
            where: { role: 'owner' },
            orderBy: { createdAt: 'asc' },
            take: 1,
            include: { user: true },
          },
        },
      });
      if (!account) throw new UnauthorizedException('代登录的工作区不存在');
      // Fall back to the admin's identity if the tenant has no owner row
      // (shouldn't happen — signup always creates one — but be defensive).
      const owner = account.members[0]?.user;
      const displayedUser = owner ?? user;
      return {
        user: {
          id: displayedUser.id,
          email: displayedUser.email,
          displayName: displayedUser.displayName,
          isPlatformAdmin: false,
          emailVerified: displayedUser.emailVerified,
        },
        account: {
          id: account.id,
          name: account.name,
          slug: account.slug,
          role: 'admin',
          status: account.status,
          suspendedReason: account.suspendedReason,
        },
        impersonation: {
          originalUser: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
          },
        },
      };
    }

    const membership = await this.prisma.accountUser.findUnique({
      where: { accountId_userId: { accountId, userId } },
      include: { account: true },
    });
    if (!membership) throw new UnauthorizedException('无权访问该工作区');
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isPlatformAdmin: user.isPlatformAdmin,
        emailVerified: user.emailVerified,
      },
      account: {
        id: membership.account.id,
        name: membership.account.name,
        slug: membership.account.slug,
        role: membership.role,
        status: membership.account.status,
        suspendedReason: membership.account.suspendedReason,
      },
      impersonation: null,
    };
  }

  // -------------------------------------------------------------------------
  // Impersonation (Platform Admin "代登录" any tenant)
  // -------------------------------------------------------------------------

  /**
   * Mint a fresh token pair that lets the calling Platform Admin act inside
   * `targetAccountId` as if they were a member. The token still carries the
   * admin's own `sub` (so audit/refresh stay tied to the human) but
   * `accountId` flips to the target and `impersonatedBy` is set so the
   * frontend can render the banner and downstream code can relax the
   * suspension gate.
   */
  async impersonate(
    adminUserId: string,
    targetAccountId: string,
    ua?: string,
    ip?: string,
  ): Promise<AuthTokens> {
    const admin = await this.prisma.user.findUnique({ where: { id: adminUserId } });
    if (!admin) throw new UnauthorizedException();
    if (!admin.isPlatformAdmin) throw new ForbiddenException('需要平台管理员权限');

    const target = await this.prisma.account.findUnique({
      where: { id: targetAccountId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('目标工作区不存在');

    this.logger.log(
      `Impersonation start: admin=${admin.email} (${admin.id}) -> account=${target.id}`,
    );
    return this.issueTokens(admin.id, target.id, true, ua, ip, admin.id);
  }

  /**
   * Exit "代登录" and return to the admin's home workspace. We resolve the
   * admin's first AccountUser membership (signup always creates exactly
   * one). Token rotation is implicit: the new pair drops `impersonatedBy`.
   */
  async endImpersonate(adminUserId: string, ua?: string, ip?: string): Promise<AuthTokens> {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      include: { memberships: { take: 1 } },
    });
    if (!admin) throw new UnauthorizedException();
    if (!admin.isPlatformAdmin) throw new ForbiddenException('需要平台管理员权限');
    const home = admin.memberships[0]?.accountId;
    if (!home) throw new UnauthorizedException('管理员未关联任何工作区');

    this.logger.log(`Impersonation end: admin=${admin.email} (${admin.id})`);
    return this.issueTokens(admin.id, home, true, ua, ip, null);
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';
    let slug = base;
    let i = 1;
    while (await this.prisma.account.findUnique({ where: { slug } })) {
      i += 1;
      slug = `${base}-${i}`;
      if (i > 1000) {
        slug = `${base}-${randomBytes(3).toString('hex')}`;
        break;
      }
    }
    return slug;
  }

  private async issueTokens(
    userId: string,
    accountId: string,
    isPlatformAdmin: boolean,
    ua: string | undefined,
    ip: string | undefined,
    impersonatedBy: string | null,
  ): Promise<AuthTokens> {
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL') ?? ACCESS_TTL_FALLBACK;
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL') ?? REFRESH_TTL_FALLBACK;
    const refreshSecret = this.config.getOrThrow<string>('JWT_REFRESH_SECRET');

    const accessPayload: Record<string, unknown> = { sub: userId, accountId, isPlatformAdmin };
    if (impersonatedBy) accessPayload.impersonatedBy = impersonatedBy;
    const accessToken = await this.jwt.signAsync(accessPayload, { expiresIn: accessTtl });
    // jti makes each refresh token unique even when issued in the same second
    // — without it, two issuances with identical { sub, type, iat } collide on
    // the refresh_tokens.token_hash UNIQUE constraint (revoked rows still
    // hold the row).
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, type: 'refresh', jti: randomBytes(8).toString('hex') },
      { secret: refreshSecret, expiresIn: refreshTtl },
    );

    const expiresAt = parseDurationToFutureDate(refreshTtl);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        userAgent: ua,
        ip,
        expiresAt,
        accountId,
        impersonatedBy,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: ttlSeconds(accessTtl),
    };
  }

  private async verifyRefreshToken(token: string): Promise<{ sub: string }> {
    const refreshSecret = this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
    try {
      return await this.jwt.verifyAsync(token, { secret: refreshSecret });
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ttlSeconds(ttl: string): number {
  const m = ttl.match(/^(\d+)([smhd])$/);
  if (!m) return 900;
  const n = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      return 900;
  }
}

function parseDurationToFutureDate(ttl: string): Date {
  const seconds = ttlSeconds(ttl);
  return new Date(Date.now() + seconds * 1000);
}

export class _BadInput extends BadRequestException {}
