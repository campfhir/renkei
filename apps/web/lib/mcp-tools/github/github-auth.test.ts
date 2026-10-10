/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The wire boundary: what oauthGitHubAuth actually SENDS. The tool suite
 * stubs auth.fetch, so nothing there would catch a request leaving for the
 * wrong URL, or one carrying a credential this process should never hold.
 * The delegate worker holds the token (docs/delegate-key-design.md): the
 * grant's fetcher attaches it, so what leaves THIS process is a call on
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
  GITHUB: 'github',
  readGitHubMetadata: () => ({ login: 'octocat' }),
}));

import { oauthGitHubAuth } from './github-auth';
import type { MCPToolContext } from '../common';

const context = {
  subject: 'subject-1',
  origin: 'https://renkei.example',
} as unknown as MCPToolContext;

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
  describeResult = { ok: true, val: { accountId: '12345', metadata: { login: 'octocat' } } };
});

describe('what actually leaves the process', () => {
  it('sends through the grant’s fetcher, to GitHub, with no Authorization of its own', async () => {
    const auth = oauthGitHubAuth(context);
    const response = await auth.fetch(['repository'], '/user/installations?per_page=100');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/installations?per_page=100');
    const headers = init.headers as Record<string, string>;
    // The delegate attaches the credential; this process never has one to send.
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Accept).toBe('application/vnd.github+json');
  });

  it('refuses locally, with the reconnect pointer, when there is no GitHub grant', async () => {
    describeResult = { ok: false, err: { type: 'NO_GRANT' } };
    const auth = oauthGitHubAuth(context);
    const response = await auth.fetch(['repository'], '/user/installations?per_page=100');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('GitHub is not connected');
  });

  it('renders a refusal the delegate issued itself in the resolver’s words', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'GRANT_REVOKED' } }), {
        status: 401,
        headers: { 'x-delegate-error': 'GRANT_REVOKED' },
      })
    );
    const auth = oauthGitHubAuth(context);
    const response = await auth.fetch(['repository'], '/user');

    expect(response.ok).toBe(false);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('revoked');
  });

  it('a capability the connection lacks is refused before any network call', async () => {
    const auth = oauthGitHubAuth({
      ...context,
      githubScopes: ['repository'],
    } as unknown as MCPToolContext);
    const response = await auth.fetch(['pullrequest:write'], '/x');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });
});
