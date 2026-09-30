import type { SegmentDefinition } from '@sendmast/shared';
import { compileSegment } from './segment-evaluator';

describe('compileSegment order rules', () => {
  it('keeps any-time order rules on the denormalized contact field', () => {
    const compiled = compileSegment(definition({ type: 'order', op: 'has' }));

    expect(compiled.pgWhere).toEqual({ AND: [{ lastOrderedAt: { not: null } }] });
    expect(compiled.orderConstraints).toEqual([]);
  });

  it('keeps recent order rules on the denormalized contact field', () => {
    const now = Date.now();
    const compiled = compileSegment(definition({ type: 'order', op: 'notHas', lastDays: 30 }));

    expect(compiled.orderConstraints).toEqual([]);
    const clause = (compiled.pgWhere.AND as Array<Record<string, unknown>>)[0];
    const since = ((clause.OR as Array<Record<string, unknown>>)[1].lastOrderedAt as { lt: Date })
      .lt;
    expect(since.getTime()).toBeGreaterThanOrEqual(now - 30 * 86_400_000 - 100);
  });

  it('compiles a fixed order range into an order constraint', () => {
    const from = '2026-08-01T00:00:00.000Z';
    const to = '2026-08-31T23:59:59.999Z';
    const compiled = compileSegment(definition({ type: 'order', op: 'has', from, to }));

    expect(compiled.pgWhere).toEqual({});
    expect(compiled.orderConstraints).toEqual([
      { mode: 'has', from: new Date(from), to: new Date(to) },
    ]);
  });
});

function definition(rule: SegmentDefinition['rules'][number]): SegmentDefinition {
  return { v: 1, op: 'AND', rules: [rule] };
}
