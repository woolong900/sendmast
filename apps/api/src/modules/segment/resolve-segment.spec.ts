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
  it('unions enriched contact ids with the recipient compatibility lookup', async () => {
    const prisma = fakePrisma(['contact-direct'], [{ contactId: 'contact-direct' }]);
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('contact_id != toUUID')) return [{ contact_id: 'contact-direct' }];
      if (sql.includes('recipient_id != toUUID')) return [{ recipient_id: 'recipient-direct' }];
      if (sql.includes('campaign_recipients_archive')) return [];
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await resolveSegmentContactIds(
      { prisma, ch: { query } as never },
      ACCOUNT_ID,
      openedDefinition(),
    );

    expect([...result]).toEqual(['contact-direct']);
    expect((prisma as any).campaignRecipient.findMany).toHaveBeenCalledWith({
      where: { accountId: ACCOUNT_ID, id: { in: ['recipient-direct'] } },
      select: { contactId: true },
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('maps event recipients through both hot and archived recipient stores', async () => {
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

  it('validates large event audiences in bind-safe candidate chunks', async () => {
    const ids = Array.from({ length: 25_001 }, (_, i) => `contact-${i}`);
    const contactFindMany = jest.fn(async ({ where }: any) => {
      const idClause = where.AND.at(-1);
      return idClause.id.in.map((id: string) => ({ id }));
    });
    const prisma = {
      contact: { findMany: contactFindMany },
      campaignRecipient: { findMany: jest.fn() },
    } as never;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('contact_id != toUUID')) {
        return ids.map((contact_id) => ({ contact_id }));
      }
      if (sql.includes('recipient_id != toUUID')) return [];
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await resolveSegmentContactIds(
      { prisma, ch: { query } as never },
      ACCOUNT_ID,
      openedDefinition(),
    );

    expect(result.size).toBe(25_001);
    expect(contactFindMany).toHaveBeenCalledTimes(2);
    expect(contactFindMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: expect.anything() }),
    );
  });
});
