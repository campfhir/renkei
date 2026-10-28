import {
  fakeAccount,
  fakeAtlassianSite,
  fakeOrganization,
  fakeAuthorizationCode,
  fakeIdentityAnswer,
  fakeOAuthActive,
  fakeOAuthFor,
  fakeTokenAnswer,
  readFakeAuthorizationCode,
} from './fake-oauth';
import { scopesFromAccessToken } from './token-claims';

function withStore<T>(value: string | undefined, run: () => T): T {
  const before = process.env.RENKEI_DATA_STORE;
  if (value === undefined) delete process.env.RENKEI_DATA_STORE;
  else process.env.RENKEI_DATA_STORE = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.RENKEI_DATA_STORE;
    else process.env.RENKEI_DATA_STORE = before;
  }
}

describe('the fake OAuth switch', () => {
  it('is off when the store is Postgres', () => {
    withStore(undefined, () => {
      expect(fakeOAuthActive()).toBe(false);
      expect(fakeOAuthFor('zoom')).toBe(false);
    });
    withStore('postgres', () => {
      expect(fakeOAuthActive()).toBe(false);
      expect(fakeOAuthFor('atlassian')).toBe(false);
    });
  });

  it('is on for the in-memory store, except for a remote MCP server', () => {
    withStore('memory', () => {
      expect(fakeOAuthActive()).toBe(true);
      expect(fakeOAuthFor('github')).toBe(true);
      expect(fakeOAuthFor('mcp:3f1c')).toBe(false);
    });
  });
});

describe('fake consent, exchange and identity', () => {
  const consent = { subject: 'person-a', provider: 'atlassian-admin', scope: 'read:jira-user' };

  it('round-trips the consent through the code, and refuses any other code', () => {
    expect(readFakeAuthorizationCode(fakeAuthorizationCode(consent))).toEqual(consent);
    expect(readFakeAuthorizationCode('a-real-vendor-code')).toBeNull();
  });

  it('keeps one account per person and provider family', () => {
    expect(fakeAccount('person-a', 'atlassian').id).toBe(
      fakeAccount('person-a', 'atlassian-admin').id
    );
    expect(fakeAccount('person-a', 'atlassian').id).not.toBe(
      fakeAccount('person-b', 'atlassian').id
    );
    expect(fakeAccount('person-a', 'github').id).toMatch(/^\d+$/);
  });

  it('mints Atlassian tokens carrying the scopes asked for', () => {
    const answer = fakeTokenAnswer('atlassian-admin', consent);
    expect(typeof answer.access_token).toBe('string');
    expect(scopesFromAccessToken(String(answer.access_token))).toEqual(['read:jira-user']);
    expect(answer.expires_in).toBe(3600);
  });

  it("names a Salesforce org's instance and identity URLs", () => {
    const answer = fakeTokenAnswer(
      'salesforce',
      { subject: 'person-a', provider: 'salesforce', scope: null },
      { instanceUrl: 'https://acme.my.salesforce.com' }
    );
    expect(answer.instance_url).toBe('https://acme.my.salesforce.com');
    expect(String(answer.id)).toMatch(/\/id\/00D[A-Z0-9]{12}\/005[A-Z0-9]{12}$/);
  });

  it('answers the identity reads by path, whatever the host', () => {
    const me = fakeIdentityAnswer(
      'atlassian-admin',
      new URL('https://api.atlassian.com/ex/jira/x/rest/api/3/myself'),
      consent
    );
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ accountId: fakeAccount('person-a', 'atlassian').id });
    const other = fakeIdentityAnswer('zoom', new URL('https://api.zoom.us/v2/meetings'), {
      ...consent,
      provider: 'zoom',
    });
    expect(other.status).toBe(404);
  });
});

describe('the organization a fake site belongs to', () => {
  it('is the email domain, shared by colleagues; a person with no address of their own is alone', () => {
    expect(fakeOrganization('s-1', 'ana@acme.example')).toBe('acme.example');
    expect(fakeAtlassianSite(fakeOrganization('s-2', 'bo@acme.example')).cloudId).toBe(
      fakeAtlassianSite('acme.example').cloudId
    );
    expect(fakeOrganization('e2e-1@example.test', 'e2e-1@example.test')).toBe('e2e-1@example.test');
    expect(fakeOrganization('s-3', null)).toBe('s-3');
  });
});
