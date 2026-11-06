import {
  filterSuppressed,
  materialiseCampaignAudience,
  matchesRecipientBlockPattern,
} from '@sendmast/audience';

/** Minimal in-memory Prisma double covering what the audience module touches. */
function fakePrisma(opts: {
  contacts: Array<{ id: string; email: string; listIds: string[] }>;
  suppressed: string[];
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const prisma = {
    contactList: {
      findMany: async ({ where }: any) =>
        where.id.in.map((id: string) => ({ id, name: `list-${id}` })),
    },
    contact: {
      findMany: async ({ where, take, cursor }: any) => {
        const listIds: string[] = where.memberships.some.listId.in;
        let rows = opts.contacts
          .filter((c) => c.listIds.some((l) => listIds.includes(l)))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (cursor) rows = rows.filter((c) => c.id > cursor.id);
        return rows.slice(0, take).map((c) => ({
          id: c.id,
          email: c.email,
          memberships: c.listIds.filter((l) => listIds.includes(l)).map((listId) => ({ listId })),
        }));
      },
    },
    suppressionEntry: {
      findMany: async ({ where }: any) =>
        opts.suppressed.filter((e) => where.email.in.includes(e)).map((email) => ({ email })),
    },
    campaignRecipient: {
      createMany: async ({ data }: any) => {
        inserted.push(...data);
        return { count: data.length };
      },
    },
    segment: { findFirst: async () => null },
  };
  return { prisma: prisma as never, inserted };
}

describe('audience materialisation', () => {
  it('matches exact recipient domains and wildcard patterns', () => {
    expect(matchesRecipientBlockPattern('User@Gmail.com', 'gmail.com')).toBe(true);
    expect(matchesRecipientBlockPattern('user@school.edu', '*.edu')).toBe(true);
    expect(matchesRecipientBlockPattern('vip42@example.com', 'vip*@example.com')).toBe(true);
    expect(matchesRecipientBlockPattern('user@yahoo.com', 'gmail.com')).toBe(false);
  });

  it('filterSuppressed drops suppressed addresses case-insensitively', async () => {
    const { prisma } = fakePrisma({ contacts: [], suppressed: ['b@x.com'] });
    const res = await filterSuppressed(prisma, 'acc', [{ email: 'a@x.com' }, { email: 'B@x.com' }]);
    expect(res.kept).toEqual([{ email: 'a@x.com' }]);
    expect(res.suppressed).toBe(1);
  });

  it('skips suppressed contacts, keeps list name and rotates senders', async () => {
    const { prisma, inserted } = fakePrisma({
      contacts: [
        { id: '1', email: 'a@x.com', listIds: ['L2'] },
        { id: '2', email: 'bounced@x.com', listIds: ['L1'] },
        { id: '3', email: 'c@x.com', listIds: ['L1', 'L2'] },
      ],
      suppressed: ['bounced@x.com'],
    });
    const res = await materialiseCampaignAudience(
      { prisma, ch: { query: async () => [] } },
      {
        campaignId: 'cmp',
        accountId: 'acc',
        listIds: ['L1', 'L2'],
        segmentIds: [],
        senders: [
          { fromEmail: 's1@d.com', fromName: 'S1', emailChannelId: 'ch1' },
          { fromEmail: 's2@e.com', fromName: 'S2', emailChannelId: 'ch2' },
        ],
      },
    );
    expect(res).toEqual({ inserted: 2, suppressed: 1, blocked: 0 });
    expect(inserted.map((r) => r.email)).toEqual(['a@x.com', 'c@x.com']);
    // contact 3 is in both lists → first by selection order (L1)
    expect(inserted[1].listName).toBe('list-L1');
    expect(inserted.map((r) => r.emailChannelId)).toEqual(['ch1', 'ch2']);
  });

  it('routes around blocked senders and drops recipients blocked by every sender', async () => {
    const { prisma, inserted } = fakePrisma({
      contacts: [
        { id: '1', email: 'a@gmail.com', listIds: ['L1'] },
        { id: '2', email: 'b@yahoo.com', listIds: ['L1'] },
        { id: '3', email: 'c@school.edu', listIds: ['L1'] },
      ],
      suppressed: [],
    });
    const res = await materialiseCampaignAudience(
      { prisma, ch: { query: async () => [] } },
      {
        campaignId: 'cmp',
        accountId: 'acc',
        listIds: ['L1'],
        segmentIds: [],
        senders: [
          {
            fromEmail: 's1@d.com',
            fromName: 'S1',
            emailChannelId: 'ch1',
            recipientRules: [
              { mode: 'block', recipientPattern: 'gmail.com' },
              { mode: 'block', recipientPattern: '*.edu' },
            ],
          },
          {
            fromEmail: 's2@e.com',
            fromName: 'S2',
            emailChannelId: 'ch2',
            recipientRules: [{ mode: 'block', recipientPattern: '*.edu' }],
          },
        ],
      },
    );
    expect(res).toEqual({ inserted: 2, suppressed: 0, blocked: 1 });
    expect(inserted.map((r) => [r.email, r.fromEmail])).toEqual([
      ['a@gmail.com', 's2@e.com'],
      ['b@yahoo.com', 's1@d.com'],
    ]);
  });

  it('treats allow rules as an allowlist and routes to another eligible sender', async () => {
    const { prisma, inserted } = fakePrisma({
      contacts: [
        { id: '1', email: 'a@gmail.com', listIds: ['L1'] },
        { id: '2', email: 'b@school.edu', listIds: ['L1'] },
      ],
      suppressed: [],
    });
    const res = await materialiseCampaignAudience(
      { prisma, ch: { query: async () => [] } },
      {
        campaignId: 'cmp',
        accountId: 'acc',
        listIds: ['L1'],
        segmentIds: [],
        senders: [
          {
            fromEmail: 's1@news.example.com',
            fromName: 'S1',
            emailChannelId: 'ch1',
            recipientRules: [{ mode: 'allow', recipientPattern: '*.edu' }],
          },
          { fromEmail: 's2@other.com', fromName: 'S2', emailChannelId: 'ch2' },
        ],
      },
    );
    expect(res).toEqual({ inserted: 2, suppressed: 0, blocked: 0 });
    expect(inserted.map((row) => [row.email, row.fromEmail])).toEqual([
      ['a@gmail.com', 's2@other.com'],
      ['b@school.edu', 's1@news.example.com'],
    ]);
  });

  it('gives matching allow rules priority over block rules', async () => {
    const { prisma, inserted } = fakePrisma({
      contacts: [{ id: '1', email: 'blocked@school.edu', listIds: ['L1'] }],
      suppressed: [],
    });
    const res = await materialiseCampaignAudience(
      { prisma, ch: { query: async () => [] } },
      {
        campaignId: 'cmp',
        accountId: 'acc',
        listIds: ['L1'],
        segmentIds: [],
        senders: [
          {
            fromEmail: 's1@news.example.com',
            fromName: 'S1',
            emailChannelId: 'ch1',
            recipientRules: [
              { mode: 'allow', recipientPattern: '*.edu' },
              { mode: 'block', recipientPattern: 'blocked@school.edu' },
            ],
          },
        ],
      },
    );
    expect(res).toEqual({ inserted: 1, suppressed: 0, blocked: 0 });
    expect(inserted).toHaveLength(1);
  });

  it('single sender leaves from-columns null and stamps the primary channel', async () => {
    const { prisma, inserted } = fakePrisma({
      contacts: [{ id: '1', email: 'a@x.com', listIds: ['L1'] }],
      suppressed: [],
    });
    await materialiseCampaignAudience(
      { prisma, ch: { query: async () => [] } },
      {
        campaignId: 'cmp',
        accountId: 'acc',
        listIds: ['L1'],
        segmentIds: [],
        senders: [{ fromEmail: 's1@d.com', fromName: 'S1', emailChannelId: 'ch1' }],
      },
    );
    expect(inserted[0]).toMatchObject({ fromEmail: null, fromName: null, emailChannelId: 'ch1' });
  });
});
