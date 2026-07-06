import { classifyBounce } from './bounce-classifier';

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
});
