/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * loadApprovalFieldSchema's one real job outside plumbing: never throw, and
 * never make an approval card's render fail because Jira is unreachable
 * or not connected. The happy path (grant described → schema fetched and
 * enriched) is a thin wrapper over already-tested primitives
 * (field-schema.test.ts, jira-auth), so what is worth pinning here is the
 * wiring and the failure modes.
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
  ATLASSIAN: 'atlassian',
  readAtlassianMetadata: (metadata: Record<string, unknown>) => ({
    cloudId: typeof metadata?.cloudId === 'string' ? metadata.cloudId : '',
    siteUrl: typeof metadata?.siteUrl === 'string' ? metadata.siteUrl : '',
  }),
}));

jest.mock('./jira-auth', () => ({
  oauthJiraAuth: (context: unknown) => ({ kind: 'oauth', context }),
}));

const loadFieldSchema = jest.fn(async (..._args: unknown[]) => [
  { id: 'priority', name: 'Priority', custom: false, type: 'option', clauseNames: [] },
]);
const enrichFieldsWithAllowedValues = jest.fn(async (...args: unknown[]) => {
  const fields = args[2] as { id: string }[];
  return fields.map((field) =>
    field.id === 'priority' ? { ...field, allowedValues: [{ value: 'High' }] } : field
  );
});
jest.mock('./field-schema', () => ({
  loadFieldSchema: (...args: unknown[]) => loadFieldSchema(...args),
  enrichFieldsWithAllowedValues: (...args: unknown[]) => enrichFieldsWithAllowedValues(...args),
}));

import { loadApprovalFieldSchema } from './approval-field-schema';

beforeEach(() => {
  jest.clearAllMocks();
  describeResult = {
    ok: true,
    val: {
      accountId: 'acct-1',
      subject: 'alice',
      metadata: { cloudId: 'cloud-1', siteUrl: 'https://acme.atlassian.net' },
    },
  };
});

describe('loadApprovalFieldSchema', () => {
  it('returns null when the tenant has no Jira grant for this subject', async () => {
    describeResult = { ok: false, err: { type: 'NO_GRANT' } };
    const result = await loadApprovalFieldSchema('alice', { projectKey: 'CIO' });
    expect(result).toBeNull();
    expect(loadFieldSchema).not.toHaveBeenCalled();
    // The approver's own grant, by subject — never someone else's.
    expect(describeMock).toHaveBeenCalledWith({
      provider: 'atlassian',
      subject: 'alice',
    });
  });

  it('returns null when the grant cannot be described', async () => {
    describeResult = { ok: false, err: { type: 'DELEGATE_UNREACHABLE' } };
    const result = await loadApprovalFieldSchema('alice', { projectKey: 'CIO' });
    expect(result).toBeNull();
  });

  it('builds the context on the grant’s fetcher, then loads and enriches the schema', async () => {
    const result = await loadApprovalFieldSchema('alice', {
      projectKey: 'CIO',
      issueType: 'Project',
    });
    expect(enrichFieldsWithAllowedValues).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
        siteUrl: 'https://acme.atlassian.net',
        accountId: 'acct-1',
        jiraAuth: expect.any(Function),
      }),
      expect.anything(),
      expect.anything(),
      { projectKey: 'CIO', issueType: 'Project' }
    );
    // The grant's fetcher is the delegate's, for the approver's own grant.
    const context = enrichFieldsWithAllowedValues.mock.calls[0][0] as {
      jiraAuth: { grantKey: string };
    };
    expect(context.jiraAuth.grantKey).toBe('atlassian:alice');
    expect(result).toEqual([
      {
        id: 'priority',
        name: 'Priority',
        custom: false,
        type: 'option',
        clauseNames: [],
        allowedValues: [{ value: 'High' }],
      },
    ]);
  });

  it('returns null rather than throwing when the live fetch fails', async () => {
    loadFieldSchema.mockRejectedValueOnce(new Error('Jira is down'));
    const result = await loadApprovalFieldSchema('alice', { projectKey: 'CIO' });
    expect(result).toBeNull();
  });
});
