import { createHmac } from 'node:crypto';
import { verifyGitHubSignature } from './github-webhook';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifyGitHubSignature', () => {
  it('accepts a correctly signed delivery', () => {
    const body = '{"action":"completed"}';
    const secret = 'a-webhook-secret';
    expect(verifyGitHubSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    const body = '{"action":"completed"}';
    expect(verifyGitHubSignature(body, sign(body, 'wrong-secret'), 'a-webhook-secret')).toBe(false);
  });

  it('rejects a body that was tampered with after signing', () => {
    const secret = 'a-webhook-secret';
    const signature = sign('{"action":"completed"}', secret);
    expect(verifyGitHubSignature('{"action":"cancelled"}', signature, secret)).toBe(false);
  });

  it('rejects a missing signature, a missing secret, or a malformed header', () => {
    const body = '{"a":1}';
    const secret = 'a-webhook-secret';
    expect(verifyGitHubSignature(body, null, secret)).toBe(false);
    expect(verifyGitHubSignature(body, sign(body, secret), '')).toBe(false);
    expect(verifyGitHubSignature(body, 'not-a-real-signature', secret)).toBe(false);
    expect(verifyGitHubSignature(body, sign(body, secret).replace('sha256=', 'sha1='), secret)).toBe(
      false
    );
  });
});
