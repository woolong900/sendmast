import type { SegmentDefinition } from '@sendmast/shared';
import { countSegment, planSegment, type AudienceContext } from './resolve-segment';

/**
 * Recompute every segment's cachedCount (daily job, runs in worker-sender).
 * COUNT-based: no segment's audience is held in memory. Sequential so one
 * tenant's large segments don't pile concurrent scans onto Postgres.
 */
export async function refreshSegmentCounts(
  ctx: AudienceContext,
): Promise<{ total: number; refreshed: number; failed: number }> {
  const segments = await ctx.prisma.segment.findMany({
    select: { id: true, accountId: true, definition: true },
    orderBy: { createdAt: 'asc' },
  });
  let refreshed = 0;
  let failed = 0;
  for (const seg of segments) {
    try {
      const plan = await planSegment(
        ctx,
        seg.accountId,
        seg.definition as unknown as SegmentDefinition,
      );
      const count = await countSegment(ctx, plan);
      await ctx.prisma.segment.update({
        where: { id: seg.id },
        data: { cachedCount: count, cachedAt: new Date() },
      });
      refreshed += 1;
    } catch (err) {
      failed += 1;
      ctx.logger?.warn(`segment refresh failed for ${seg.id}: ${(err as Error).message}`);
    }
  }
  return { total: segments.length, refreshed, failed };
}
