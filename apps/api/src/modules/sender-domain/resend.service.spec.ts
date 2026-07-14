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
});
