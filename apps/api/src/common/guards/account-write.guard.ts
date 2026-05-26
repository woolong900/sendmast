import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { AuthService } from '../../modules/auth/auth.service';
import type { AuthenticatedUser } from '../../modules/auth/jwt.strategy';

/**
 * Globally enforces tenant suspension on every write request.
 *
 * Why an Interceptor (not a Guard):
 *   Global Nest guards execute BEFORE per-route guards, so at guard time
 *   `JwtAuthGuard` hasn't populated `req.user` yet — the suspension check
 *   would silently be skipped on every JWT-protected route. Interceptors
 *   run AFTER the full guard pipeline, so by then `req.user` is set
 *   exactly when authentication succeeded.
 *
 * Allow rules:
 *   1. Read methods (GET / HEAD / OPTIONS) skip — suspension blocks writes only.
 *   2. Unauthenticated requests skip — they're either public endpoints or
 *      will be rejected by the route's own JwtAuthGuard.
 *   3. White-listed self-management write paths (auth/* mostly) are allowed
 *      even while suspended so the user can still log out / change password
 *      / receive an unsuspend notification.
 *
 * Pending-activation tenants are NOT blocked here — they retain most write
 * permissions per product spec. The two endpoints that DO need full
 * activation (campaign create + start) call `auth.assertActive()` directly
 * in the service layer.
 */
@Injectable()
export class AccountWriteInterceptor implements NestInterceptor {
  constructor(private readonly auth: AuthService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const user = req.user as AuthenticatedUser | undefined;
      // Platform Admins acting via "代登录" must keep write access even when
      // the target tenant is suspended — that's literally the workflow for
      // fixing data on a frozen account before lifting the suspension.
      if (user?.accountId && !user.impersonatedBy && !WRITE_WHITELIST.has(req.path)) {
        await this.auth.assertWritable(user.accountId);
      }
    }
    return next.handle();
  }
}

/**
 * Mutation endpoints that even a suspended tenant must keep access to.
 * Match against `req.path` (already prefixed with the global `/api`).
 *
 * Adding a new self-management endpoint? Append it here AND remember that
 * pending_activation users can use ALL of these (resend activation is the
 * obvious one).
 */
const WRITE_WHITELIST = new Set<string>([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/change-password',
  '/api/auth/resend-activation',
  '/api/auth/activate',
]);

// Re-export so callers (e.g. tests, future special-case code) can throw
// the canonical exception when they detect a suspended tenant outside the
// interceptor pipeline. Not used today but cheap and self-documenting.
export { ForbiddenException as AccountSuspendedException };
