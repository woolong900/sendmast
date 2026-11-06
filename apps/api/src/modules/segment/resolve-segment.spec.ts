import type { SegmentDefinition } from '@sendmast/shared';
import { resolveSegmentContactIds } from '@sendmast/audience';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

function openedDefinition(): SegmentDefinition {
  return {
    v: 1,
    op: 'AND',
    rules: [{ type: 'event', op: 'has', event: 'open', lastDays: 300 }],
  };
}

function fakePrisma(contactIds: string[], legacyLinks: Array<{ contactId: string }> = []) {
  return {
    contact: {
      findMany: jest.fn(async () => contactIds.map((id) => ({ id }))),
    },
    campaignRecipient: {
      findMany: jest.fn(async () => legacyLinks),
    },
  } as never;
}

describe('resolveSegmentContactIds event compatibility', () => {
  it('uses enriched contact ids without a Postgres recipient lookup', async () => {
    const prisma = fakePrisma(['contact-direct']);
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('contact_id != toUUID')) return [{ contact_id: 'contact-direct' }];
      if (sql.includes('recipient_id != toUUID')) return [];
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await resolveSegmentContactIds(
      { prisma, ch: { query } as never },
      ACCOUNT_ID,
      openedDefinition(),
    );

    expect([...result]).toEqual(['contact-direct']);
    expect((prisma as any).campaignRecipient.findMany).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('maps zero-contact legacy events through both hot and archived recipients', async () => {
    const prisma = fakePrisma(['contact-hot', 'contact-archived'], [{ contactId: 'contact-hot' }]);
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('contact_id != toUUID')) return [];
      if (sql.includes('recipient_id != toUUID')) {
        return [{ recipient_id: 'recipient-hot' }, { recipient_id: 'recipient-archived' }];
      }
      if (sql.includes('campaign_recipients_archive')) {
        return [{ contact_id: 'contact-archived' }];
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await resolveSegmentContactIds(
      { prisma, ch: { query } as never },
      ACCOUNT_ID,
      openedDefinition(),
    );

    expect([...result]).toEqual(['contact-hot', 'contact-archived']);
    expect((prisma as any).campaignRecipient.findMany).toHaveBeenCalledWith({
      where: {
        accountId: ACCOUNT_ID,
        id: { in: ['recipient-hot', 'recipient-archived'] },
      },
      select: { contactId: true },
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('keeps hot legacy matches when the cold archive lookup fails', async () => {
    const prisma = fakePrisma(['contact-hot'], [{ contactId: 'contact-hot' }]);
    const warn = jest.fn();
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('contact_id != toUUID')) return [];
      if (sql.includes('recipient_id != toUUID')) return [{ recipient_id: 'recipient-hot' }];
      if (sql.includes('campaign_recipients_archive')) throw new Error('archive unavailable');
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await resolveSegmentContactIds(
      { prisma, ch: { query } as never, logger: { warn } },
      ACCOUNT_ID,
      openedDefinition(),
    );

    expect([...result]).toEqual(['contact-hot']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('archived event evaluation failed'));
  });
});
