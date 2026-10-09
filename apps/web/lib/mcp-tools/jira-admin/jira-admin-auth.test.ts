/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthJiraAdminAuth` in isolation — the confluence-auth.test.ts shape:
 * resolve() asks the delegate for the caller's own grant on the fifth
 * Atlassian app and hands back its fetcher, and every way it can come up
 * empty is a sentence, never a throw.
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
  ATLASSIAN_ADMIN: 'atlassian-admin',
  readAtlassianMetadata: (metadata: Record<string, unknown>) => ({
    cloudId: typeof metadata?.cloudId === 'string' ? metadata.cloudId : '',
    siteUrl: typeof metadata?.siteUrl === 'string' ? metadata.siteUrl : '',
  }),
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import { oauthJiraAdminAuth } from './jira-admin-auth';
import type { MCPToolContext } from '../common';

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({ subject: 'subject-1', ...overrides }) as unknown as MCPToolContext;

const described = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  val: {
    accountId: 'acct-1',
    metadata: { cloudId: 'cloud-1', siteUrl: 'https://acme.atlassian.net' },
    ...overrides,
  },
});

beforeEach(() => {
  describeMock.mockClear();
  describeResult = described();
});

describe('oauthJiraAdminAuth', () => {
  it('resolves the caller’s own admin grant, with its site', async () => {
    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toMatchObject({
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      accountId: 'acct-1',
    });
    expect(typeof access === 'string' ? '' : access.auth.grantKey).toBe(
      'atlassian-admin:subject-1'
    );
    // The admin grant, never the everyday Jira one.
    expect(describeMock).toHaveBeenCalledWith({
      provider: 'atlassian-admin',
      subject: 'subject-1',
    });
  });

  it('says how to connect when the caller has no admin grant', async () => {
    describeResult = { ok: false, err: { type: 'NO_GRANT' } };

    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toContain('Jira Administration is not connected');
  });

  it('asks for a reconnect when the delegate finds the grant revoked', async () => {
    describeResult = { ok: false, err: { type: 'GRANT_REVOKED' } };

    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toContain('revoked');
  });

  it('refuses a grant with no site id rather than calling a blank cloud', async () => {
    describeResult = described({ metadata: {} });

    const access = await oauthJiraAdminAuth(context()).resolve();

    expect(access).toContain('missing its site id');
  });

  it('reports a session with no subject as a sentence, not a throw', async () => {
    const access = await oauthJiraAdminAuth(context({ subject: undefined })).resolve();

    expect(access).toContain('No signed-in subject');
    expect(describeMock).not.toHaveBeenCalled();
  });
});
