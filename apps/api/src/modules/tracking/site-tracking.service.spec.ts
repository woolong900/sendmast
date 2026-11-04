import { compileSegment } from '@sendmast/audience';
import { ShopyyError } from '@sendmast/shopyy';
import { SiteTrackingService } from './site-tracking.service';

const shopyyCalls: { saved: unknown[][]; listResults: unknown[][]; saveError: Error | null } = {
  saved: [],
  // successive GET /scripts responses (one array per call)
  listResults: [],
  saveError: null,
};
jest.mock('@sendmast/shopyy', () => {
  const actual = jest.requireActual('@sendmast/shopyy');
  return {
    ...actual,
    ShopyyClient: class {
      async batchSaveScripts(items: unknown[]) {
        if (shopyyCalls.saveError) throw shopyyCalls.saveError;
        shopyyCalls.saved.push(items);
        return true;
      }
      async listScripts() {
        return shopyyCalls.listResults.shift() ?? [];
      }
    },
  };
});

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

describe('SiteTrackingService.installViaApi', () => {
  function installSetup(initial: { siteTrackingScriptId: number | null }) {
    const row: Record<string, unknown> = {
      id: 'shop-1',
      accountId: 'acc-1',
      status: 'active',
      openapiDomain: 'https://openapi.example.com',
      devToken: 'tok',
      siteTrackingKey: KEY,
      siteTrackingInstall: null,
      siteTrackingLastSeenAt: null,
      ...initial,
    };
    const prisma = {
      shopConnection: {
        findFirst: jest.fn(async () => row),
        findUnique: jest.fn(async () => row),
        updateMany: jest.fn(async () => ({ count: 0 })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
          Object.assign(row, data),
        ),
      },
    };
    const config = { getOrThrow: () => 'https://app.example.com', get: () => undefined };
    const svc = new SiteTrackingService(prisma as never, {} as never, config as never);
    return { svc, row };
  }

  beforeEach(() => {
    shopyyCalls.saved = [];
    shopyyCalls.listResults = [];
    shopyyCalls.saveError = null;
  });

  it('creates the loader on all pages incl. checkout and recovers its id', async () => {
    const { svc, row } = installSetup({ siteTrackingScriptId: null });
    // before the save the store has only someone else's script; after it, ours
    shopyyCalls.listResults = [
      [{ id: 5, script_name: 'site_whatsapp_contact' }],
      [
        { id: 5, script_name: 'site_whatsapp_contact' },
        { id: 77, script_name: 'sendmast_site_tracking' },
      ],
    ];
    const status = await svc.installViaApi('acc-1', 'shop-1');
    const item = shopyyCalls.saved[0][0] as Record<string, unknown>;
    expect(item).toMatchObject({
      scriptName: 'sendmast_site_tracking',
      displayRoutes: 'all',
      displayCheckout: true,
      enabled: true,
      detail: `<script async src="https://app.example.com/t/s/sdk.js?k=${KEY}"></script>`,
    });
    expect(item.id).toBeUndefined();
    expect(row.siteTrackingInstall).toBe('api');
    expect(row.siteTrackingScriptId).toBe(77);
    expect(status.install).toBe('api');
  });

  it('updates in place when the script id is known', async () => {
    const { svc } = installSetup({ siteTrackingScriptId: 4497066 });
    await svc.installViaApi('acc-1', 'shop-1');
    expect((shopyyCalls.saved[0][0] as { id: number }).id).toBe(4497066);
  });

  it('turns a missing script permission into an actionable error', async () => {
    const { svc } = installSetup({ siteTrackingScriptId: null });
    shopyyCalls.saveError = new ShopyyError('No permission', 401);
    await expect(svc.installViaApi('acc-1', 'shop-1')).rejects.toThrow('自定义脚本');
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
