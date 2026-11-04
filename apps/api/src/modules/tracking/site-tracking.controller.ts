import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { SiteTrackingService } from './site-tracking.service';

/**
 * Public storefront endpoints (no auth, cross-origin from merchant stores).
 *   GET  /t/s/sdk.js?k=<siteKey>  the embed script
 *   POST /t/s/e                   event beacons (text/plain JSON, no preflight)
 */
@ApiExcludeController()
@Controller('t/s')
export class SiteTrackingController {
  constructor(private readonly svc: SiteTrackingService) {}

  @Get('sdk.js')
  async sdk(@Query('k') key: string | undefined, @Res() res: Response) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    const valid = typeof key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(key);
    const site = valid ? await this.svc.resolveKey(key) : null;
    if (!valid || !site) {
      // Unknown / disconnected store: ship a no-op so the theme never errors.
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send('/* SendMast: unknown site key */');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(this.svc.renderScript(key));
  }

  @Post('e')
  @HttpCode(204)
  async event(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      await this.svc.ingest(body, req.ip, req.headers['user-agent']?.toString());
    } catch {
      // Never surface errors to the storefront.
    }
    res.status(204).end();
  }
}
