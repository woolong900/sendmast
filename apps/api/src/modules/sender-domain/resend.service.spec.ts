import type { EmailChannel } from '@prisma/client';
import { ResendService } from './resend.service';

describe('ResendService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('checks domain status without triggering Resend re-verification', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'dom_123',
          status: 'verified',
          records: [
            {
              record: 'SPF',
              type: 'TXT',
              name: 'example.com',
              value: 'v=spf1',
              status: 'verified',
            },
            {
              record: 'DKIM',
              type: 'CNAME',
              name: 'resend._domainkey.example.com',
              value: 'dkim.resend.com',
              status: 'verified',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const service = new ResendService();
    const acct = {
      name: 'Resend',
      resendApiKey: 're_test',
      resendApiBaseUrl: 'https://api.resend.test',
    } as unknown as EmailChannel;

    const states = await service.verifyDomain(acct, 'dom_123');

    expect(states.SPF?.status).toBe('Verified');
    expect(states.DKIM?.status).toBe('Verified');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.test/domains/dom_123');
    expect(String(url)).not.toContain('/verify');
    expect(init?.method).toBeUndefined();
  });

  it('starts Resend verification for a domain that has not started', async () => {
    const body = (status: string) =>
      new Response(
        JSON.stringify({
          id: 'dom_new',
          status,
          records: [
            { record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=x', status },
          ],
        }),
        { status: 200 },
      );
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(body('not_started'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'dom_new' }), { status: 200 }))
      .mockResolvedValueOnce(body('pending'));
    const acct = {
      name: 'Resend',
      resendApiKey: 're_test',
      resendApiBaseUrl: 'https://api.resend.test',
    } as unknown as EmailChannel;

    const states = await new ResendService().verifyDomain(acct, 'dom_new');

    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method ?? 'GET'} ${u}`)).toEqual([
      'GET https://api.resend.test/domains/dom_new',
      'POST https://api.resend.test/domains/dom_new/verify',
      'GET https://api.resend.test/domains/dom_new',
    ]);
    expect(states.DKIM?.status).toBe('VerificationRequested');
  });
});
