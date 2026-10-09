/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthConfluenceAuth` in isolation.
 *
 * Narrow, like graph-auth.test.ts — see confluence-auth.ts's header for
 * why resolve() is the whole interface. The grant is described by the
 * delegate and fetched through it (docs/delegate-key-design.md): what to
 * pin is that resolve() hands back the delegate's fetcher for the caller's
 * own Confluence grant, and that every way it can come up empty is a
 * sentence, never a throw. There is no denied/no-sandbox tier here (unlike
 * WebEx/Zoom/Graph): Confluence has a real sandbox, exercised end to end in
 * confluence.integration.test.ts instead.
 */

let describeResult: unknown;
const describeMock = jest.fn(async () => describeResult);

jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({ describe: describeMock }),
    grantFetch: (ref: Parameters<typeof actual.grantKeyOf>[0]) =>
      actual.authedFetch(async () => new Response('{}'), actual.grantKeyOf(ref)),
  };
});
jest.mock('@renkei/provider-grants', () => ({
  ATLASSIAN_CONFLUENCE: 'atlassian-confluence',
  readAtlassianMetadata: (metadata: unknown) => ({
    cloudId: (metadata as { cloudId?: string })?.cloudId ?? '',
    siteUrl: '',
  }),
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import { oauthConfluenceAuth } from './confluence-auth';
import type { MCPToolContext } from '../common';

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
    ...overrides,
  }) as unknown as MCPToolContext;

beforeEach(() => {
  describeMock.mockClear();
  describeResult = {
    ok: true,
    val: { accountId: 'acct-1', metadata: { cloudId: 'cloud-1' } },
  };
});

describe('oauthConfluenceAuth', () => {
  it('resolves the caller’s own Confluence grant as the delegate’s fetcher, with its site', async () => {
    const auth = oauthConfluenceAuth(context());

    const access = await auth.resolve();

    expect(access).toMatchObject({ cloudId: 'cloud-1', accountId: 'acct-1' });
    expect(typeof access === 'string' ? '' : access.auth.grantKey).toBe(
      'atlassian-confluence:tenant-1:subject-1'
    );
    // The Confluence app's grant, by the caller's subject — never Jira's.
    expect(describeMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      provider: 'atlassian-confluence',
      subject: 'subject-1',
    });
  });

  it('says how to connect when the caller has no Confluence grant', async () => {
    describeResult = { ok: false, err: { type: 'NO_GRANT' } };

    const access = await oauthConfluenceAuth(context()).resolve();

    expect(access).toContain('Confluence is not connected');
  });

  it('refuses a grant with no site id rather than calling a blank cloud', async () => {
    describeResult = { ok: true, val: { accountId: 'acct-1', metadata: {} } };

    const access = await oauthConfluenceAuth(context()).resolve();

    expect(access).toContain('missing its site id');
  });

  it('reports an unresolved grant as a string, not a thrown error', async () => {
    const auth = oauthConfluenceAuth(context({ subject: undefined }));

    const access = await auth.resolve();

    expect(typeof access).toBe('string');
    expect(access).toContain('No signed-in subject');
    expect(describeMock).not.toHaveBeenCalled();
  });

  it('kind is "oauth"', () => {
    expect(oauthConfluenceAuth(context()).kind).toBe('oauth');
  });
});
