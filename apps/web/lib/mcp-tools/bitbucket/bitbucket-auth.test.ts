/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The wire boundary: what oauthBitbucketAuth actually SENDS. The tool
 * suite stubs auth.fetch, so nothing there would catch a request leaving
 * for the wrong URL, or one carrying a credential this process should never
 * hold. The delegate worker holds the token (docs/delegate-key-design.md):
 * the grant's fetcher attaches it, so what leaves THIS process is a call on
 * that fetcher with no Authorization of its own. This suite mocks nothing
 * below the delegate client: grant described → fetcher → the exact request.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

let describeResult: unknown;
const fetchSpy = jest.fn();

jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({ describe: async () => describeResult }),
    grantFetch: (ref: Parameters<typeof actual.grantKeyOf>[0]) =>
      actual.authedFetch((url, init) => fetchSpy(url, init), actual.grantKeyOf(ref)),
  };
});
jest.mock('@renkei/provider-grants', () => ({
  ATLASSIAN_BITBUCKET: 'atlassian-bitbucket',
  readBitbucketMetadata: () => ({ username: 'scott' }),
}));

import { oauthBitbucketAuth } from './bitbucket-auth';
import type { MCPToolContext } from '../common';

const context = {
  tenantId: 'tenant-1',
  subject: 'subject-1',
  origin: 'https://renkei.example',
} as unknown as MCPToolContext;

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ values: [] }), { status: 200 }));
  describeResult = { ok: true, val: { accountId: '{u-1}', metadata: { username: 'scott' } } };
});

describe('what actually leaves the process', () => {
  it('sends through the grant’s fetcher, to Bitbucket, with no Authorization of its own', async () => {
    const auth = oauthBitbucketAuth(context);
    const response = await auth.fetch(['account'], '/workspaces?pagelen=50');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.bitbucket.org/2.0/workspaces?pagelen=50');
    // The delegate attaches the credential (and Bitbucket is exact about its
    // spelling — see describeBitbucketFailure); this process sends none.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('refuses locally, with the reconnect pointer, when there is no Bitbucket grant', async () => {
    describeResult = { ok: false, err: { type: 'NO_GRANT' } };
    const auth = oauthBitbucketAuth(context);
    const response = await auth.fetch(['account'], '/workspaces?pagelen=50');

    // Refused locally — never a credential-less request on the wire, which
    // Bitbucket would answer with the misleading anonymous 404.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Bitbucket is not connected');
  });

  it('renders a refusal the delegate issued itself in the resolver’s words', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'REFRESH_FAILED' } }), {
        status: 401,
        headers: { 'x-delegate-error': 'REFRESH_FAILED' },
      })
    );
    const auth = oauthBitbucketAuth(context);
    const response = await auth.fetch(['account'], '/user');

    expect(response.ok).toBe(false);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Could not refresh the Bitbucket token');
  });

  it('a scope the connection lacks is refused before any network call', async () => {
    const auth = oauthBitbucketAuth({
      ...context,
      bitbucketScopes: ['repository'],
    } as unknown as MCPToolContext);
    const response = await auth.fetch(['pullrequest:write'], '/x');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });
});
