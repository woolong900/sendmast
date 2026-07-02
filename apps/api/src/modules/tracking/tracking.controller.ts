import { Body, Controller, Get, HttpStatus, Param, Query, Req, Res, Post } from '@nestjs/common';
import { ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { TRANSPARENT_GIF } from '@sendmast/email-tracking';
import { TrackingService } from './tracking.service';

@ApiTags('tracking')
@Controller('t')
export class TrackingController {
  constructor(private readonly svc: TrackingService) {}

  /** Open tracking pixel; tolerant: always returns the GIF. */
  @Get('o/:token.gif')
  @ApiExcludeEndpoint()
  async open(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const payload = this.svc.verify(token);
    if (payload && payload.k === 'o') {
      await this.svc.record({
        payload,
        ip: clientIp(req),
        userAgent: req.headers['user-agent']?.toString(),
      });
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(HttpStatus.OK).end(TRANSPARENT_GIF);
  }

  /** Click tracking - 302 to original URL. */
  @Get('c/:token')
  @ApiExcludeEndpoint()
  async click(
    @Param('token') token: string,
    @Query('u') target: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const payload = this.svc.verify(token);
    let dest = '/';
    if (payload && payload.k === 'c') {
      const resolved = await this.svc.resolveClickTarget(payload, target);
      if (!resolved) {
        res.redirect(HttpStatus.FOUND, dest);
        return;
      }
      dest = resolved;
      await this.svc.record({
        payload,
        ip: clientIp(req),
        userAgent: req.headers['user-agent']?.toString(),
        linkUrl: resolved,
      });
    }
    res.redirect(HttpStatus.FOUND, dest);
  }

  /**
   * Unsubscribe confirmation page. Renders a small HTML form so the user
   * can pick a reason (or leave blank) before confirming. Submitting the
   * form posts back to the same URL with `reason` in form-urlencoded body.
   *
   * NOTE: We deliberately do NOT unsubscribe on GET. Some email clients and
   * spam scanners pre-fetch links to score them; unsubscribing on GET would
   * silently drop those subscribers. The form POST gates the action behind
   * an explicit user click.
   */
  @Get('u/:token')
  @ApiExcludeEndpoint()
  async unsubscribePage(@Param('token') token: string, @Res() res: Response) {
    const payload = this.svc.verify(token);
    if (!payload || payload.k !== 'u') {
      res.status(400).send(htmlPage('This unsubscribe link is invalid or expired.'));
      return;
    }
    res.send(unsubscribeFormPage(token));
  }

  /**
   * Unsubscribe confirmation. Two callers:
   *   1) RFC 8058 one-click — email clients POST with empty body, no reason.
   *   2) Our own confirmation page — POSTs `reason` from the radio group.
   *
   * The same handler serves both because RFC 8058 says the URL in the
   * `List-Unsubscribe-Post` header must accept any POST body shape.
   */
  @Post('u/:token')
  @ApiExcludeEndpoint()
  async unsubscribePost(
    @Param('token') token: string,
    @Body() body: { reason?: string; reason_other?: string } | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const payload = this.svc.verify(token);
    if (!payload || payload.k !== 'u') {
      // For form submits we still return a friendly HTML page; for one-click
      // POSTs (no reason field) returning a plain status is fine — the email
      // client doesn't render the body.
      const acceptHtml = (req.headers['accept'] ?? '').toString().includes('text/html');
      if (acceptHtml)
        res.status(400).send(htmlPage('This unsubscribe link is invalid or expired.'));
      else res.status(400).end();
      return;
    }

    // The "Other" radio sends the literal value "Other" alongside
    // `reason_other` textbox content; collapse to the textbox value when present.
    const raw = body?.reason ?? '';
    const reason = raw === 'Other' ? (body?.reason_other ?? '').trim() : raw.trim();

    const result = await this.svc.unsubscribeByToken(payload, reason || undefined);

    const acceptHtml = (req.headers['accept'] ?? '').toString().includes('text/html');
    if (acceptHtml) {
      // Form submission from our HTML page → render success page.
      if (result.ok) {
        res.send(
          htmlPage(
            `You have been unsubscribed.${result.email ? `<br/>Email: ${escapeHtml(result.email)}` : ''}`,
          ),
        );
      } else {
        res.status(404).send(htmlPage('Subscription not found.'));
      }
    } else {
      // RFC 8058 one-click → bare status code, no body rendering.
      res.status(result.ok ? 200 : 404).end();
    }
  }
}

function clientIp(req: Request): string | undefined {
  return req.ip;
}

function htmlPage(msg: string): string {
  // `msg` is allowed to contain a small set of safe inline tags (<br/>) since
  // we control the call sites. Escaping is applied at the call site for any
  // user-controlled portions (e.g. email addresses).
  return `<!doctype html><html><head><meta charset="utf-8"><title>SendMast</title>
  <style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f7;margin:0}
  .card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);text-align:center;max-width:380px}</style></head>
  <body><div class="card"><h2>SendMast</h2><p>${msg}</p></div></body></html>`;
}

/**
 * The five preset reasons mirror what Mailchimp / SendGrid offer; "Other"
 * unlocks a free-form textbox so we don't lose long-tail feedback. The
 * value strings are persisted verbatim into ClickHouse, so don't translate
 * existing values without considering historical reads.
 */
const UNSUBSCRIBE_REASONS = [
  'Too many emails',
  'Content not relevant',
  "I don't remember subscribing",
  'Not interested anymore',
  'Other',
];

function unsubscribeFormPage(token: string): string {
  const safeToken = encodeURIComponent(token);
  const radios = UNSUBSCRIBE_REASONS.map(
    (r, i) => `<label class="row">
        <input type="radio" name="reason" value="${escapeHtml(r)}" ${i === 0 ? 'checked' : ''} />
        <span>${escapeHtml(r)}</span>
      </label>`,
  ).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>SendMast · Unsubscribe</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f7;margin:0;padding:24px;box-sizing:border-box}
    .card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);max-width:420px;width:100%}
    h2{margin:0 0 8px;font-size:18px}
    p.lead{margin:0 0 20px;color:#666;font-size:14px}
    .row{display:flex;align-items:center;gap:8px;padding:8px 0;font-size:14px;cursor:pointer}
    .row input{margin:0}
    textarea{width:100%;min-height:60px;margin-top:8px;padding:8px;border:1px solid #ddd;border-radius:6px;font-family:inherit;font-size:13px;box-sizing:border-box;resize:vertical}
    button{margin-top:20px;width:100%;padding:10px;border:0;border-radius:8px;background:#111;color:#fff;font-size:14px;cursor:pointer}
    button:hover{background:#333}
  </style></head>
  <body><div class="card">
    <h2>Unsubscribe</h2>
    <p class="lead">Help us improve — tell us why you're unsubscribing.</p>
    <form method="post" action="/t/u/${safeToken}" accept-charset="utf-8">
      ${radios}
      <textarea name="reason_other" placeholder="If you chose 'Other', please tell us more (optional)"></textarea>
      <button type="submit">Confirm unsubscribe</button>
    </form>
  </div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
