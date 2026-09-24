/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * loadApprovalFieldSchema's one real job outside plumbing: never throw, and
 * never make an approval card's render fail because Jira is unreachable
 * or not connected. The happy path (grant found → schema fetched and
 * enriched) is a thin wrapper over already-tested primitives
 * (field-schema.test.ts, jira-auth), so what is worth pinning here is the
 * wiring and the failure modes.
 */

let grantRow: { provider_account_id: string } | undefined;
const executeTakeFirst = jest.fn(async () => grantRow);

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            where: () => ({
              where: () => ({
                executeTakeFirst,
              }),
            }),
          }),
        }),
      }),
    },
  }),
}));

let jiraGrant: unknown;
let jiraGrantOk = true;
jest.mock('@/lib/tenant-operations', () => ({
  ATLASSIAN: 'atlassian',
  getJiraGrant: async () => (jiraGrantOk ? { ok: true, val: jiraGrant } : { ok: false }),
}));

const cacheTokenMetadata = jest.fn();
jest.mock('../common', () => ({
  cacheTokenMetadata: (...args: unknown[]) => cacheTokenMetadata(...args),
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
  grantRow = { provider_account_id: 'acct-1' };
  jiraGrantOk = true;
  jiraGrant = {
    accountId: 'acct-1',
    subject: 'alice',
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    accessToken: 'tok',
  };
});

describe('loadApprovalFieldSchema', () => {
  it('returns null when the tenant has no Jira grant for this subject', async () => {
    grantRow = undefined;
    const result = await loadApprovalFieldSchema('t1', 'alice', { projectKey: 'CIO' });
    expect(result).toBeNull();
    expect(loadFieldSchema).not.toHaveBeenCalled();
  });

  it('returns null when the grant fails to load', async () => {
    jiraGrantOk = false;
    const result = await loadApprovalFieldSchema('t1', 'alice', { projectKey: 'CIO' });
    expect(result).toBeNull();
  });

  it('caches the token, then loads and enriches the schema for the given source', async () => {
    const result = await loadApprovalFieldSchema('t1', 'alice', {
      projectKey: 'CIO',
      issueType: 'Project',
    });
    expect(cacheTokenMetadata).toHaveBeenCalledWith('tok', 't1', 'acct-1', 'alice');
    expect(enrichFieldsWithAllowedValues).toHaveBeenCalledWith(
      expect.objectContaining({ apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1' }),
      expect.anything(),
      expect.anything(),
      { projectKey: 'CIO', issueType: 'Project' }
    );
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
    const result = await loadApprovalFieldSchema('t1', 'alice', { projectKey: 'CIO' });
    expect(result).toBeNull();
  });
});
