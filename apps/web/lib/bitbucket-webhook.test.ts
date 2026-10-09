import {
  BITBUCKET_WEBHOOK_SECRET_HEADER,
  presentedBitbucketSecret,
  verifyBitbucketSecret,
} from './bitbucket-webhook';

describe('verifyBitbucketSecret', () => {
  it('accepts a matching secret', () => {
    expect(verifyBitbucketSecret('correct-secret', 'correct-secret')).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifyBitbucketSecret('wrong-secret', 'correct-secret')).toBe(false);
  });

  it('rejects a missing query parameter or a missing configured secret', () => {
    expect(verifyBitbucketSecret(null, 'correct-secret')).toBe(false);
    expect(verifyBitbucketSecret('correct-secret', '')).toBe(false);
  });
});

describe('presentedBitbucketSecret', () => {
  it('prefers the X-Renkei-Webhook-Secret header', () => {
    const headers = new Headers({ [BITBUCKET_WEBHOOK_SECRET_HEADER]: 'from-header' });
    expect(presentedBitbucketSecret(headers, new URLSearchParams('secret=from-query'))).toBe(
      'from-header'
    );
  });

  it('falls back to the legacy ?secret= query parameter', () => {
    expect(presentedBitbucketSecret(new Headers(), new URLSearchParams('secret=from-query'))).toBe(
      'from-query'
    );
  });

  it('is null when neither carries a secret', () => {
    expect(presentedBitbucketSecret(new Headers(), new URLSearchParams(''))).toBeNull();
    expect(
      presentedBitbucketSecret(
        new Headers({ [BITBUCKET_WEBHOOK_SECRET_HEADER]: '' }),
        new URLSearchParams('')
      )
    ).toBeNull();
  });
});
