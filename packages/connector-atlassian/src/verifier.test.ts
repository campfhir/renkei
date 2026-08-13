/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The gate's contract is default-deny, and these verifiers are the only
 * thing standing between "the index proposed it" and "the user sees it".
 * Every branch that could accidentally ALLOW is tested explicitly: a
 * missing grant, an API failure, an id the provider did not return.
 */

import { createJiraAccessVerifier, createConfluenceAccessVerifier } from './verifier';

interface FetchCall {
  url: string;
  body: unknown;
}

let calls: FetchCall[] = [];
/** Queued responses, consumed in order; `null` means "make this call fail". */
let responses: (Record<string, unknown> | null)[] = [];

beforeEach(() => {
  calls = [];
  responses = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = responses.shift();
    if (next === null || next === undefined) {
      return { ok: false, status: 500, statusText: 'boom', text: async () => 'boom' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  }) as unknown as typeof fetch;
});

const credential = async () => ({ accessToken: 'token-1', cloudId: 'cloud-1' });
const refs = (provider: string, ids: string[]) => ids.map((id) => ({ provider, refId: id }));

describe('createJiraAccessVerifier', () => {
  it('allows only the issues Jira actually returned for that user', async () => {
    responses = [{ issues: [{ key: 'ENG-1' }] }];
    const verifier = createJiraAccessVerifier(credential);
    const result = await verifier.verifyAccess(
      'scott@example.com',
      refs('jira', ['ENG-1', 'ENG-2'])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ENG-2 was asked about and not returned — that IS the denial.
    expect(result.val.map((ref) => ref.refId)).toEqual(['ENG-1']);
  });

  it('denies everything when the user has no Atlassian grant', async () => {
    const verifier = createJiraAccessVerifier(async () => null);
    const result = await verifier.verifyAccess('nobody@example.com', refs('jira', ['ENG-1']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val).toEqual([]);
    // And it must not have called the API at all.
    expect(calls).toHaveLength(0);
  });

  it('denies when the lookup itself throws', async () => {
    const verifier = createJiraAccessVerifier(async () => {
      throw new Error('db down');
    });
    const result = await verifier.verifyAccess('scott@example.com', refs('jira', ['ENG-1']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val).toEqual([]);
  });

  it('denies when the API call fails — an outage must not read as access', async () => {
    responses = [null];
    const verifier = createJiraAccessVerifier(credential);
    const result = await verifier.verifyAccess('scott@example.com', refs('jira', ['ENG-1']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val).toEqual([]);
  });

  it('collapses chunk refs of one issue into a single lookup, then allows each chunk', async () => {
    responses = [{ issues: [{ key: 'ENG-1' }] }];
    const verifier = createJiraAccessVerifier(credential);
    const result = await verifier.verifyAccess(
      'scott@example.com',
      refs('jira', ['ENG-1#0001', 'ENG-1#0002'])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One API call for both chunks...
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.body)).toContain('ENG-1');
    expect(JSON.stringify(calls[0]?.body)).not.toContain('#0001');
    // ...and both chunks allowed, since they are the same document.
    expect(result.val.map((ref) => ref.refId)).toEqual(['ENG-1#0001', 'ENG-1#0002']);
  });

  it('does not let one failed batch deny ids another batch verified', async () => {
    const many = Array.from({ length: 60 }, (_unused, index) => `ENG-${index}`);
    // First batch (50) fails, second (10) succeeds.
    responses = [null, { issues: [{ key: 'ENG-55' }] }];
    const verifier = createJiraAccessVerifier(credential);
    const result = await verifier.verifyAccess('scott@example.com', refs('jira', many));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.map((ref) => ref.refId)).toEqual(['ENG-55']);
  });
});

describe('createConfluenceAccessVerifier', () => {
  it('allows only the pages Confluence returned', async () => {
    responses = [{ results: [{ id: '111' }] }];
    const verifier = createConfluenceAccessVerifier(credential);
    const result = await verifier.verifyAccess(
      'scott@example.com',
      refs('confluence', ['111', '222'])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.map((ref) => ref.refId)).toEqual(['111']);
  });

  it('asks by id and strips chunk suffixes', async () => {
    responses = [{ results: [{ id: '111' }] }];
    const verifier = createConfluenceAccessVerifier(credential);
    await verifier.verifyAccess('scott@example.com', refs('confluence', ['111#0003']));
    expect(calls[0]?.url).toContain('id=111');
    expect(calls[0]?.url).not.toContain('%230003');
  });

  it('denies on API failure', async () => {
    responses = [null];
    const verifier = createConfluenceAccessVerifier(credential);
    const result = await verifier.verifyAccess('scott@example.com', refs('confluence', ['111']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val).toEqual([]);
  });

  it('handles a numeric page id, which Confluence sometimes returns unquoted', async () => {
    responses = [{ results: [{ id: 111 }] }];
    const verifier = createConfluenceAccessVerifier(credential);
    const result = await verifier.verifyAccess('scott@example.com', refs('confluence', ['111']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.map((ref) => ref.refId)).toEqual(['111']);
  });
});
