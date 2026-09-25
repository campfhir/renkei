import { verifyBitbucketSecret } from './bitbucket-webhook';

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
