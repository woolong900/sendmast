import { SesService } from './ses.service';

const acct = {
  name: 'ses-test',
  sesAccessKeyId: 'AKIATEST',
  sesSecretAccessKey: 'secret',
  sesRegion: 'us-east-1',
} as never;

describe('SesService.createDomain', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('adopts an identity that already exists in the SES account', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ message: 'Email identity mzscx.com already exists.' }),
          {
            status: 400,
          },
        );
      }
      return new Response(
        JSON.stringify({
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: 'SUCCESS', Tokens: ['t1', 't2', 't3'] },
        }),
        { status: 200 },
      );
    }) as never;

    const r = await new SesService().createDomain(acct, 'mzscx.com');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(calls[1].url).toContain('/v2/email/identities/mzscx.com');
    expect(r.records.map((x) => x.name)).toEqual([
      't1._domainkey',
      't2._domainkey',
      't3._domainkey',
    ]);
    expect(r.states.DKIM?.status).toBe('Verified');
  });

  it('still surfaces other SES errors', async () => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ message: 'Access denied' }), { status: 403 }),
    ) as never;
    await expect(new SesService().createDomain(acct, 'mzscx.com')).rejects.toThrow('Access denied');
  });
});
