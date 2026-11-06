import { countSegment, pageSegment, planSegment, scanSegment } from '@sendmast/audience';

const ACC = '11111111-1111-4111-8111-111111111111';

interface Row {
  id: string;
  accountId: string;
  email: string;
  subscriptionStatus: string;
}

/** Evaluates the subset of Prisma where-shapes the audience planner emits. */
function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(v as any[]).every((w) => matches(row, w))) return false;
    } else if (k === 'NOT') {
      if (matches(row, v)) return false;
    } else if (k === 'id') {
      const c = v as any;
      if (typeof c === 'string' && row.id !== c) return false;
      if (c.in && !c.in.includes(row.id)) return false;
      if (c.gt && !(row.id > c.gt)) return false;
    } else if ((row as any)[k] !== v) {
      return false;
    }
  }
  return true;
}

function fakePrisma(rows: Row[]) {
  const calls = { findMany: 0, count: 0, maxRowsReturned: 0 };
  const prisma = {
    contact: {
      findMany: jest.fn(async (args: any) => {
        calls.findMany++;
        let out = rows
          .filter((r) => matches(r, args.where))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (args.skip) out = out.slice(args.skip);
        if (args.take) out = out.slice(0, args.take);
        calls.maxRowsReturned = Math.max(calls.maxRowsReturned, out.length);
        return out.map((r) => ({ ...r }));
      }),
      count: jest.fn(async (args: any) => {
        calls.count++;
        return rows.filter((r) => matches(r, args.where)).length;
      }),
    },
    campaignRecipient: { findMany: jest.fn(async () => []) },
  };
  return { prisma: prisma as never, calls };
}

const pad = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({
  id: pad(i),
  accountId: ACC,
  email: `u${i}@x.com`,
  subscriptionStatus: i % 5 === 0 ? 'unsubscribed' : 'subscribed',
}));

function ch(openers: string[], carters: string[] = []): any {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('site_events')) return carters.map((cid) => ({ cid }));
      if (sql.includes('contact_id != toUUID')) return openers.map((cid) => ({ cid }));
      return [];
    }),
  };
}

describe('segment plan (count / page / scan without loading the audience)', () => {
  it('pure contact rule: one COUNT, page via skip/take, keyset scan in batches', async () => {
    const { prisma, calls } = fakePrisma(rows);
    const ctx = { prisma, ch: ch([]) };
    const plan = await planSegment(ctx, ACC, {
      v: 1,
      op: 'AND',
      rules: [{ type: 'subscription', op: 'eq', value: 'subscribed' }],
    });
    expect(await countSegment(ctx, plan)).toBe(40);
    expect(calls.count).toBe(1);
    const page2 = await pageSegment(ctx, plan, 2, 3, { id: true });
    // subscribed = every id not divisible by 5 → 1,2,3 | 4,6,7 | …
    expect(page2.map((r) => r.id)).toEqual([pad(4), pad(6), pad(7)]);
    const seen: string[] = [];
    for await (const b of scanSegment(ctx, plan, { select: { id: true }, batchSize: 7 })) {
      expect(b.length).toBeLessThanOrEqual(7);
      seen.push(...b.map((r) => r.id));
    }
    expect(seen).toHaveLength(40);
    expect(calls.maxRowsReturned).toBeLessThanOrEqual(7 + 3);
  });

  it('has-event ∩ not-has-site-event: inclusion minus exclusion', async () => {
    const { prisma } = fakePrisma(rows);
    const openers = [pad(1), pad(2), pad(3), pad(5), pad(9)];
    const ctx = { prisma, ch: ch(openers, [pad(2)]) };
    const plan = await planSegment(ctx, ACC, {
      v: 1,
      op: 'AND',
      rules: [
        { type: 'event', op: 'has', event: 'open', lastDays: 30 },
        { type: 'siteEvent', op: 'notHas', event: 'purchase', lastDays: 30 },
        { type: 'subscription', op: 'eq', value: 'subscribed' },
      ],
    });
    expect(plan.include).toEqual([pad(1), pad(3), pad(5), pad(9)]);
    // pad(5) is unsubscribed → excluded by the contact rule
    expect(await countSegment(ctx, plan)).toBe(3);
    expect((await pageSegment(ctx, plan, 1, 2, { id: true })).map((r) => r.id)).toEqual([
      pad(1),
      pad(3),
    ]);
  });

  it('not-has only: total minus the excluded ids that match', async () => {
    const { prisma } = fakePrisma(rows);
    const ctx = { prisma, ch: ch([pad(1), pad(5), pad(7)]) };
    const plan = await planSegment(ctx, ACC, {
      v: 1,
      op: 'AND',
      rules: [
        { type: 'event', op: 'notHas', event: 'open', lastDays: 30 },
        { type: 'subscription', op: 'eq', value: 'subscribed' },
      ],
    });
    expect(plan.include).toBeNull();
    expect(await countSegment(ctx, plan)).toBe(40 - 2); // pad(5) already unsubscribed
    const all: string[] = [];
    for await (const b of scanSegment(ctx, plan, { select: { id: true }, batchSize: 4 })) {
      all.push(...b.map((r) => r.id));
    }
    expect(all).toHaveLength(38);
    expect(all).not.toContain(pad(1));
    const p = await pageSegment(ctx, plan, 1, 3, { id: true });
    expect(p.map((r) => r.id)).toEqual([pad(2), pad(3), pad(4)]);
  });
});
