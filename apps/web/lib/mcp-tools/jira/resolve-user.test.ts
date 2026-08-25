 
/**
 * The hazard being tested is a SILENT one: Jira accepts an accountId that
 * is really an email, writes nothing, and reports success. So these assert
 * on what reaches the payload, not on whether a call returned ok.
 */

import { createUserResolver, looksLikeAccountId, resolveUserId } from './resolve-user';
import type { JiraAuth } from './jira-auth';

const fetchMock = jest.fn();
const auth: JiraAuth = {
  kind: 'oauth',
  fetch: (_scopes, path, init) => fetchMock(path, init),
};

function serve(users: unknown, ok = true, status = 200): void {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok, status, json: async () => users }));
}

const AMANDA = {
  accountId: '5b21a397a6d3c211bbc5f967',
  displayName: 'Amanda Wong',
  emailAddress: 'Amanda.Wong@nems.org',
};

describe('looksLikeAccountId', () => {
  it('accepts the id shapes Atlassian actually issues', () => {
    expect(looksLikeAccountId('5b21a397a6d3c211bbc5f967')).toBe(true);
    expect(looksLikeAccountId('557058:2f1a9c33-1f4e-4c6a-9a0e-3b2f0c1d4e5a')).toBe(true);
  });

  it('never mistakes an email for an id, however long', () => {
    expect(looksLikeAccountId('Amanda.Wong@nems.org')).toBe(false);
    expect(looksLikeAccountId('a.very.long.address.indeed@example.org')).toBe(false);
  });
});

describe('resolveUserId', () => {
  it('resolves an email to its accountId — the case that used to be handed back', () => {
    serve([AMANDA]);
    return expect(resolveUserId(auth, 'Amanda.Wong@nems.org')).resolves.toEqual({
      ok: true,
      id: AMANDA.accountId,
    });
  });

  it('matches the email case-insensitively', async () => {
    serve([AMANDA]);
    const result = await resolveUserId(auth, 'amanda.wong@NEMS.ORG');
    expect(result).toEqual({ ok: true, id: AMANDA.accountId });
  });

  it('prefers an exact email match over a prefix collision', async () => {
    serve([
      AMANDA,
      {
        accountId: 'other-account-id-000000',
        displayName: 'Amanda Wong (Contractor)',
        emailAddress: 'Amanda.Wong.Contractor@nems.org',
      },
    ]);
    const result = await resolveUserId(auth, 'Amanda.Wong@nems.org');
    expect(result).toEqual({ ok: true, id: AMANDA.accountId });
  });

  it('still resolves when the site hides email addresses', async () => {
    // Restricted profile visibility omits emailAddress entirely. Treating
    // "no exact match" as failure would break resolution for exactly the
    // orgs most careful about privacy.
    serve([{ accountId: AMANDA.accountId, displayName: 'Amanda Wong' }]);
    const result = await resolveUserId(auth, 'Amanda.Wong@nems.org');
    expect(result).toEqual({ ok: true, id: AMANDA.accountId });
  });

  it('passes an accountId straight through without searching', async () => {
    serve([]);
    const result = await resolveUserId(auth, AMANDA.accountId);
    expect(result).toEqual({ ok: true, id: AMANDA.accountId });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses ambiguity rather than guessing, and names the candidates', async () => {
    serve([
      { accountId: 'aaaaaaaaaaaaaaaaaaaaaaaa', displayName: 'Amanda Wong' },
      { accountId: 'bbbbbbbbbbbbbbbbbbbbbbbb', displayName: 'Amanda Wongler' },
    ]);
    const result = await resolveUserId(auth, 'Amanda');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('matches 2 users');
    expect(result.reason).toContain('Amanda Wong (aaaaaaaaaaaaaaaaaaaaaaaa)');
  });

  it('reports a miss plainly', async () => {
    serve([]);
    const result = await resolveUserId(auth, 'nobody@nems.org');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no Jira user matches');
  });

  it('reports a failed search instead of pretending nobody matched', async () => {
    serve(null, false, 403);
    const result = await resolveUserId(auth, 'amanda@nems.org');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('403');
  });
});

describe('createUserResolver', () => {
  it('searches once for a person named in several fields', async () => {
    serve([AMANDA]);
    const resolve = createUserResolver(auth);
    const [a, b, c] = await Promise.all([
      resolve('Amanda.Wong@nems.org'),
      resolve('amanda.wong@nems.org'),
      resolve('Amanda.Wong@nems.org'),
    ]);
    expect(a).toEqual({ ok: true, id: AMANDA.accountId });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
