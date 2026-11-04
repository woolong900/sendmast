import { compileSegment } from '@sendmast/audience';
import { SiteTrackingService } from './site-tracking.service';

// @sendmast/shared ships ESM, which this CJS jest setup can't load; map the
// two runtime modules the service uses to their (dependency-free) TS sources.
jest.mock('@sendmast/shared', () => ({
  ...jest.requireActual('../../../../../packages/shared/src/schemas/site-events'),
  ...jest.requireActual('../../../../../packages/shared/src/queue-names'),
}));

const MID = '3f2b8c1e-1d2a-4b5c-9e8f-0a1b2c3d4e5f';
const KEY = 'sk_abcdefghijklmnop1234';

function setup(conn: { id: string; accountId: string; status: string } | null) {
  const jobs: unknown[] = [];
  const prisma = {
    shopConnection: {
      findUnique: jest.fn(async () => conn),
      update: jest.fn(async () => ({})),
    },
  };
  const queue = { add: jest.fn(async (_q: string, _n: string, data: unknown) => jobs.push(data)) };
  const config = { getOrThrow: () => 'https://app.example.com/' };
  const svc = new SiteTrackingService(prisma as never, queue as never, config as never);
  return { svc, jobs, prisma };
}

describe('SiteTrackingService.ingest', () => {
  it('enqueues a valid text/plain beacon for an active store and clamps bad timestamps', async () => {
    const { svc, jobs } = setup({ id: 'shop-1', accountId: 'acc-1', status: 'active' });
    const body = JSON.stringify({
      k: KEY,
      mid: MID,
      sid: 's1',
      e: [{ t: 'add_to_cart', ts: 1, v: 12.5, c: 'USD' }],
    });
    await svc.ingest(body, '1.2.3.4', 'UA');
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as { shopId: string; accountId: string; events: Array<{ ts: number }> };
    expect(job.shopId).toBe('shop-1');
    expect(job.accountId).toBe('acc-1');
    expect(Math.abs(job.events[0].ts - Date.now())).toBeLessThan(5000);
  });

  it('drops malformed bodies, unknown event types and inactive stores', async () => {
    const ok = setup({ id: 'shop-1', accountId: 'acc-1', status: 'active' });
    await ok.svc.ingest('not json');
    await ok.svc.ingest(JSON.stringify({ k: KEY, mid: MID, e: [{ t: 'hack' }] }));
    await ok.svc.ingest(JSON.stringify({ k: KEY, mid: 'not-a-uuid', e: [{ t: 'page_view' }] }));
    expect(ok.jobs).toHaveLength(0);

    const revoked = setup({ id: 'shop-2', accountId: 'acc-1', status: 'revoked' });
    await revoked.svc.ingest(JSON.stringify({ k: KEY, mid: MID, e: [{ t: 'page_view' }] }));
    expect(revoked.jobs).toHaveLength(0);
  });

  it('builds the embed snippet on the app origin', () => {
    const { svc } = setup(null);
    expect(svc.snippet(KEY)).toBe(
      `<script async src="https://app.example.com/t/s/sdk.js?k=${KEY}"></script>`,
    );
    expect(svc.renderScript(KEY)).toContain('"https://app.example.com/t/s/e"');
  });
});

describe('siteEvent segment rule', () => {
  it('compiles to a site event constraint with defaults', () => {
    const c = compileSegment({
      v: 1,
      op: 'AND',
      rules: [
        { type: 'siteEvent', event: 'add_to_cart', op: 'has', lastDays: 7 },
        { type: 'siteEvent', event: 'purchase', op: 'notHas', lastDays: 7, minCount: 2 },
      ],
    });
    expect(c.pgWhere).toEqual({});
    expect(c.siteEventConstraints.map((s) => [s.event, s.mode, s.minCount])).toEqual([
      ['add_to_cart', 'has', 1],
      ['purchase', 'notHas', 2],
    ]);
  });
});
