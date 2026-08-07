/**
 * Tests for token endpoint client authentication.
 *
 * The bug these guard against: registration handed clients
 * `token_endpoint_auth_method: "client_secret_basic"`, the token endpoint read
 * credentials only from the request body, and a client that followed
 * instructions got `invalid_request`. Anything that only accepts one of the two
 * placements reintroduces it.
 */

import { readClientCredentials, verifyClientSecret } from './oauth-client-auth';

// mcp-token reaches the Kysely client for token storage, which is ESM and
// cannot be required here. The digest helpers under test touch no database.
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false, err: 'unused' }) }));

import { digestsMatch, hashToken } from './mcp-token';

function basic(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
}

describe('readClientCredentials', () => {
  it('reads credentials from an Authorization: Basic header', () => {
    expect(readClientCredentials(basic('client-1', 'secret-1'), {})).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      method: 'client_secret_basic',
    });
  });

  it('reads credentials from the request body', () => {
    expect(
      readClientCredentials(null, { client_id: 'client-1', client_secret: 'secret-1' })
    ).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      method: 'client_secret_post',
    });
  });

  it('prefers the header when both are present, as RFC 6749 directs', () => {
    const creds = readClientCredentials(basic('from-header', 'header-secret'), {
      client_id: 'from-body',
      client_secret: 'body-secret',
    });

    expect(creds?.clientId).toBe('from-header');
    expect(creds?.method).toBe('client_secret_basic');
  });

  it('accepts the scheme case-insensitively', () => {
    const header = basic('client-1', 'secret-1').replace('Basic', 'basic');
    expect(readClientCredentials(header, {})?.clientId).toBe('client-1');
  });

  it('splits on the first colon so a secret may contain one', () => {
    expect(readClientCredentials(basic('client-1', 'aa:bb:cc'), {})?.clientSecret).toBe('aa:bb:cc');
  });

  it('form-decodes each half, per RFC 6749 section 2.3.1', () => {
    const header = `Basic ${Buffer.from('client%201:secret%2Fwith%2Fslashes').toString('base64')}`;

    expect(readClientCredentials(header, {})).toEqual({
      clientId: 'client 1',
      clientSecret: 'secret/with/slashes',
      method: 'client_secret_basic',
    });
  });

  it('keeps the raw halves when a client did not percent-encode them', () => {
    // A bare '%' makes decodeURIComponent throw; rejecting outright would lock
    // out clients that skip the encoding step, which many do.
    const header = `Basic ${Buffer.from('client-1:100%pure').toString('base64')}`;

    expect(readClientCredentials(header, {})?.clientSecret).toBe('100%pure');
  });

  describe('returns null rather than guessing', () => {
    it.each([
      ['nothing supplied', null, {}],
      ['a body missing the secret', null, { client_id: 'client-1' }],
      ['a body missing the id', null, { client_secret: 'secret-1' }],
      ['a bearer header', 'Bearer some-token', {}],
      ['an empty Basic header', 'Basic ', {}],
      ['a header with no colon', `Basic ${Buffer.from('nocolon').toString('base64')}`, {}],
      ['an empty client id', `Basic ${Buffer.from(':secret-1').toString('base64')}`, {}],
      ['an empty secret', `Basic ${Buffer.from('client-1:').toString('base64')}`, {}],
    ])('%s', (_label, header, body) => {
      expect(readClientCredentials(header, body)).toBeNull();
    });
  });
});

describe('verifyClientSecret', () => {
  const check = (stored: unknown, presented: string) =>
    verifyClientSecret(stored, presented, hashToken, digestsMatch);

  it('accepts the secret it was issued', () => {
    expect(check(hashToken('secret-1'), 'secret-1')).toBe('ok');
  });

  it('rejects a wrong secret', () => {
    expect(check(hashToken('secret-1'), 'secret-2')).toBe('mismatch');
  });

  it('rejects the stored digest presented as if it were the secret', () => {
    const digest = hashToken('secret-1');
    expect(check(digest, digest)).toBe('mismatch');
  });

  it('reports a row that cannot authenticate anyone, separately from a mismatch', () => {
    // What a NULL column, or client_secret_hash missing because migration 012
    // has not run, arrives as. This used to throw inside Buffer.from and
    // surface at the token endpoint as a 500.
    expect(check(undefined, 'secret-1')).toBe('unusable');
    expect(check(null, 'secret-1')).toBe('unusable');
    expect(check('', 'secret-1')).toBe('unusable');
  });
});

describe('digestsMatch', () => {
  it('fails closed rather than throwing on a missing value', () => {
    expect(digestsMatch(undefined, hashToken('x'))).toBe(false);
    expect(digestsMatch(hashToken('x'), undefined)).toBe(false);
    expect(digestsMatch(null, null)).toBe(false);
  });

  it('still compares two real digests', () => {
    expect(digestsMatch(hashToken('x'), hashToken('x'))).toBe(true);
    expect(digestsMatch(hashToken('x'), hashToken('y'))).toBe(false);
  });
});
