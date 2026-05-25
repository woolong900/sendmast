import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PlatformAdminGuard } from './platform-admin.guard';
import { SystemMailModule } from '../system-mail/system-mail.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_TTL') ?? '15m' },
      }),
    }),
    // SystemMailModule re-imports AuthModule for guards, so we need the
    // forwardRef on at least one side of the cycle.
    forwardRef(() => SystemMailModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, PlatformAdminGuard],
  exports: [AuthService, JwtModule, PassportModule, PlatformAdminGuard],
})
export class AuthModule {}
