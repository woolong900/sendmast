import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TrackingPayload {
  /** recipient id (campaign_recipient row uuid) */
  r: string;
  /** kind: open / click / unsubscribe */
  k: 'o' | 'c' | 'u';
  /** optional click target index (which link) */
  i?: number;
}

const SEP = '.';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function signTrackingToken(payload: TrackingPayload, secret: string): string {
  const json = JSON.stringify(payload);
  const body = b64url(Buffer.from(json));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}${SEP}${sig}`;
}

export function verifyTrackingToken(
  token: string,
  secret: string,
): TrackingPayload | null {
  const [body, sig] = token.split(SEP);
  if (!body || !sig) return null;
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(fromB64url(body).toString('utf8')) as TrackingPayload;
  } catch {
    return null;
  }
}

