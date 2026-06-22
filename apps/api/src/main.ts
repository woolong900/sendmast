import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, RequestMethod } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // The API is only reachable through the single Caddy container in
  // production. Trust exactly that first proxy hop so Express/Throttler use
  // the real client IP from X-Forwarded-For instead of grouping every user
  // under Caddy's internal Docker address.
  app.set('trust proxy', 1);

  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      // Tracking endpoints must NOT carry the /api prefix
      { path: 't/(.*)', method: RequestMethod.ALL },
    ],
  });
  // Security headers. CSP is opt-in here because:
  //   1. Swagger UI inlines scripts at /api/docs and would break under
  //      a strict default CSP — we serve docs in dev/preview only;
  //   2. The web app is hosted separately (Vite at :5173 / a CDN in prod),
  //      so CSP belongs on that origin's response, not the API's.
  // The other helmet defaults (HSTS, X-Content-Type-Options, frameguard,
  // referrer-policy, etc.) are useful regardless of frontend hosting.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  // The `verify` hook stashes the raw bytes onto the request so payment
  // webhooks can verify signatures against the EXACT body the server sent.
  // JSON.stringify(parsed) would
  // shuffle whitespace/key-order and break the hash. Same trick used by
  // the Stripe / Shopify SDKs.
  app.use(
    json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ limit: '10mb', extended: true }));

  app.enableCors({
    origin: config.get('WEB_BASE_URL', 'http://localhost:5173'),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  const swaggerCfg = new DocumentBuilder()
    .setTitle('SendMast API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const doc = SwaggerModule.createDocument(app, swaggerCfg);
  SwaggerModule.setup('api/docs', app, doc);

  // Forward SIGINT/SIGTERM into Nest's lifecycle so PrismaService /
  // BullMQ Queue / Redis / S3 / CH clients get a chance to flush+close on
  // K8s rollout. Without this, the process is hard-killed and in-flight
  // BullMQ producer adds can be lost.
  app.enableShutdownHooks();

  const port = config.get<number>('API_PORT', 4000);
  await app.listen(port);
  logger.log(`SendMast API listening on http://localhost:${port}`);
  logger.log(`Swagger UI:  http://localhost:${port}/api/docs`);
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap:', err);
  process.exit(1);
});
