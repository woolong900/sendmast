import * as audience from '@sendmast/audience';
import { SegmentService } from './segment.service';

jest.mock('@sendmast/audience', () => ({
  ...jest.requireActual('@sendmast/audience'),
  countSegment: jest.fn(),
}));

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const SEGMENT_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const definition = {
  v: 1 as const,
  op: 'AND' as const,
  rules: [{ type: 'event' as const, op: 'has' as const, event: 'open' as const, lastDays: 30 }],
};

describe('SegmentService', () => {
  afterEach(() => jest.clearAllMocks());

  it('shares a concurrent count between preview and refresh', async () => {
    const now = new Date();
    const row = {
      id: SEGMENT_ID,
      name: 'opened',
      description: null,
      definition,
      cachedCount: 0,
      cachedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const prisma = {
      segment: {
        findFirst: jest.fn(async () => row),
        update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
      },
      campaignRecipient: { findMany: jest.fn(async () => []) },
      contact: {
        findMany: jest.fn(async () => [
          { id: CONTACT_ID, email: 'opened@example.com', firstName: null, lastName: null },
        ]),
      },
    };
    const ch = {
      query: jest.fn(async (sql: string) =>
        sql.includes('contact_id != toUUID') ? [{ cid: CONTACT_ID }] : [],
      ),
    };
    const count = jest.mocked(audience.countSegment).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 42;
    });
    const service = new SegmentService(prisma as never, ch as never);

    const [preview, refreshed] = await Promise.all([
      service.preview(ACCOUNT_ID, definition),
      service.refresh(ACCOUNT_ID, SEGMENT_ID),
    ]);

    expect(count).toHaveBeenCalledTimes(1);
    expect(preview.count).toBe(42);
    expect(refreshed.cachedCount).toBe(42);
    expect(prisma.segment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cachedCount: 42 }) }),
    );
  });
});
