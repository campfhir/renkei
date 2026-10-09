/**
 * `oauthGraphAuth` and `deniedGraphAuth` in isolation.
 *
 * Narrower than the other three connectors' auth tests because the
 * interface itself is narrower — see graph-auth.ts's header for why
 * resolve() takes no requiredScopes and there is no fetch() to wrap: Graph's
 * client.ts already separated "resolve a credential" from "make a call",
 * and this only had to make the first half swappable. What resolving yields
 * is the delegate's fetcher for the grant, never a token.
 */

jest.mock('@renkei/provider-grants', () => ({ MICROSOFT: 'microsoft' }));
jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({ describe: mockDescribe }),
    grantFetch: (ref: Parameters<typeof actual.grantKeyOf>[0]) =>
      actual.authedFetch(async () => new Response('{}'), actual.grantKeyOf(ref)),
  };
});
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

const mockDescribe = jest.fn();

import { oauthGraphAuth, deniedGraphAuth } from './graph-auth';
import type { GraphCallContext } from './client';

const context = (overrides: Partial<GraphCallContext> = {}): GraphCallContext => ({
  subject: 'subject-1',
  origin: 'https://renkei.example.com',
  ...overrides,
});

beforeEach(() => {
  mockDescribe.mockReset();
  mockDescribe.mockResolvedValue({
    ok: true,
    val: { accountId: 'acct-1', metadata: { upn: 'alice@example.com' } },
  });
});

describe('oauthGraphAuth', () => {
  it('resolves the delegate fetcher for the caller’s grant, with its upn and account', async () => {
    const auth = oauthGraphAuth(context());

    const access = await auth.resolve();

    if (typeof access === 'string') throw new Error(access);
    expect(access.upn).toBe('alice@example.com');
    expect(access.accountId).toBe('acct-1');
    expect(typeof access.auth).toBe('function');
    // The grant is named by subject; the delegate maps it to the row itself.
    expect(access.auth.grantKey).toBe('microsoft:tenant-1:subject-1');
    expect(mockDescribe).toHaveBeenCalledWith({
      provider: 'microsoft',
      subject: 'subject-1',
    });
  });

  it('phrases the delegate’s refusal as the sentence the handlers hand back', async () => {
    mockDescribe.mockResolvedValue({ ok: false, err: { type: 'NO_GRANT' } });
    const auth = oauthGraphAuth(context());

    const access = await auth.resolve();

    expect(access).toBe(
      'Microsoft is not connected. Connect it on the Connectors page, then try again.'
    );
  });

  it('reports an unresolved grant as a string, not a thrown error', async () => {
    // No subject is resolveGraphAccess's own "not signed in" failure — the
    // same union every handler already checks with `typeof access === 'string'`.
    const auth = oauthGraphAuth(context({ subject: undefined }));

    const access = await auth.resolve();

    expect(typeof access).toBe('string');
    expect(access).toContain('No signed-in identity');
    expect(mockDescribe).not.toHaveBeenCalled();
  });
});

describe('deniedGraphAuth', () => {
  it('always refuses, without asking the delegate', async () => {
    const auth = deniedGraphAuth();

    const access = await auth.resolve();

    expect(typeof access).toBe('string');
    expect(access).toContain('No Microsoft test credential is configured');
    expect(mockDescribe).not.toHaveBeenCalled();
  });
});
