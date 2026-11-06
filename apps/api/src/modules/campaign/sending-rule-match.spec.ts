import {
  isRecipientBlockedBySendingRules,
  matchesSenderDomainPattern,
} from '@sendmast/audience';

describe('sending rules', () => {
  it('matches exact and wildcard sender domains', () => {
    expect(matchesSenderDomainPattern('example.com', 'example.com')).toBe(true);
    expect(matchesSenderDomainPattern('news.example.com', '*.example.com')).toBe(true);
    expect(matchesSenderDomainPattern('example.com', '*.example.com')).toBe(false);
    expect(matchesSenderDomainPattern('anything.test', '*')).toBe(true);
  });

  it('allows unrestricted recipients when no allow rule exists', () => {
    expect(
      isRecipientBlockedBySendingRules('person@gmail.com', [
        { mode: 'block', recipientPattern: '*.edu' },
      ]),
    ).toBe(false);
  });

  it('requires a recipient to match an allow rule when allow rules exist', () => {
    const rules = [{ mode: 'allow' as const, recipientPattern: '*.edu' }];
    expect(isRecipientBlockedBySendingRules('person@school.edu', rules)).toBe(false);
    expect(isRecipientBlockedBySendingRules('person@gmail.com', rules)).toBe(true);
  });
});
