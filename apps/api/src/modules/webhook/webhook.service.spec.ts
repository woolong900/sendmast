import { classifyBounce, classifyMailgunBounce } from './bounce-classifier';

describe('classifyBounce', () => {
  it('classifies Gmail no-such-user DSNs as hard bounces', () => {
    expect(
      classifyBounce({
        deliveryStatusDetails: {
          statusMessage:
            '550-5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient email address.',
        },
      }),
    ).toBe('hard');
  });

  it('keeps sender-side reputation failures soft', () => {
    expect(
      classifyBounce({
        deliveryStatusDetails: {
          statusMessage:
            '550-5.7.1 Our system has detected that this message is likely suspicious due to the low reputation of the sending domain.',
        },
      }),
    ).toBe('soft');
  });

  it('keeps Mailgun content denials soft even when severity is permanent', () => {
    expect(
      classifyMailgunBounce({
        event: 'failed',
        severity: 'permanent',
        reason: 'generic',
        'delivery-status': {
          code: 550,
          message:
            'Mail content denied [MbmMx8+oB+H1+VyaOvrrH9UCZO1fWqsXnmylrrJhCQNZGfrq2l5Zc7k= IP: 69.72.42.252]. https://open.work.weixin.qq.com/help2/pc/20056.',
          'bounce-type': 'soft',
          'enhanced-code': '',
          'mx-host': 'mxbiz1.qq.com',
        },
      }),
    ).toBe('soft');
  });

  it('classifies Mailgun no-such-user failures as hard', () => {
    expect(
      classifyMailgunBounce({
        event: 'failed',
        severity: 'permanent',
        'delivery-status': {
          code: 550,
          message: '550 5.1.1 user unknown',
          'bounce-type': 'hard',
          'enhanced-code': '5.1.1',
        },
      }),
    ).toBe('hard');
  });
});
