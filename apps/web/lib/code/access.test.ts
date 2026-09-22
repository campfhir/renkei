import {
  grantScopesOf,
  codeProjectAccessMessage,
  codeProjectAccessOf,
  CODE_PROJECT_SCOPES,
  scopeOptionLabels,
} from './access';

const ALL = ['account', 'repository', 'repository:write', 'pullrequest', 'pullrequest:write'];

/**
 * What Bitbucket actually reports as granted on a real, healthy token: a
 * vocabulary sharing no string with the classic names requested_scopes
 * stores. The registry already knew to fall back to requested for this;
 * the Code page once intersected against it and told a fully connected
 * person their connection carried none of the three checkboxes.
 */
const BITBUCKET_LEGACY_GRANTED = [
  'admin:pipeline-variable:bitbucket-legacy',
  'admin:project:bitbucket-legacy',
  'admin:repository:bitbucket-legacy',
  'admin:webhook:bitbucket-legacy',
  'admin:wiki:bitbucket-legacy',
  'delete:repository:bitbucket-legacy',
  'offline_access',
  'read:account:bitbucket-legacy',
  'read:pipeline:bitbucket-legacy',
  'read:project:bitbucket-legacy',
  'read:pullrequest:bitbucket-legacy',
  'read:repository:bitbucket-legacy',
  'write:pipeline:bitbucket-legacy',
  'write:project:bitbucket-legacy',
  'write:pullrequest:bitbucket-legacy',
  'write:repository:bitbucket-legacy',
];

describe('grantScopesOf', () => {
  it('narrows requested by granted when granted is known, else takes requested', () => {
    expect(
      grantScopesOf({ requested_scopes: ['repository', 'pipeline'], granted_scopes: ALL })
    ).toEqual(['repository']);
    expect(
      grantScopesOf({ requested_scopes: ['repository', 'pipeline'], granted_scopes: null })
    ).toEqual(['repository', 'pipeline']);
  });

  it('takes requested alone when granted is in the vocabulary Bitbucket really reports', () => {
    expect(
      grantScopesOf({
        requested_scopes: ['repository', 'pipeline'],
        granted_scopes: BITBUCKET_LEGACY_GRANTED,
      })
    ).toEqual(['repository', 'pipeline']);
  });
});

describe('codeProjectAccessOf', () => {
  it('is not connected, missing everything, without a grant', () => {
    const access = codeProjectAccessOf(undefined);
    expect(access.connected).toBe(false);
    expect(access.ok).toBe(false);
    expect(access.missingScopes).toEqual([...CODE_PROJECT_SCOPES]);
    expect(access.missingOptions).toEqual([
      'Read repositories & code',
      'Create branches & commit files',
      'Create & act on pull requests',
    ]);
    expect(codeProjectAccessMessage(access)).toBe(
      'Connect Bitbucket on the Connectors page, with “Read repositories & code”, “Create branches & commit files” and “Create & act on pull requests” enabled, to make code projects.'
    );
  });

  it('is ok with a grant carrying clone, push and pull request scopes', () => {
    const access = codeProjectAccessOf({ requested_scopes: ALL, granted_scopes: ALL });
    expect(access).toEqual({ connected: true, missingScopes: [], missingOptions: [], ok: true });
    expect(codeProjectAccessMessage(access)).toBeNull();
  });

  it('is ok with every checkbox approved and Bitbucket reporting granted scopes in its own vocabulary', () => {
    // The screenshot case: all checkboxes on, the Connectors page saying
    // Connected, and the Code page nonetheless naming all three as missing.
    const access = codeProjectAccessOf({
      requested_scopes: [
        'repository',
        'project',
        'repository:write',
        'pullrequest',
        'pullrequest:write',
        'project:admin',
        'repository:admin',
        'pipeline',
        'pipeline:write',
        'account',
      ],
      granted_scopes: BITBUCKET_LEGACY_GRANTED,
    });
    expect(access).toEqual({ connected: true, missingScopes: [], missingOptions: [], ok: true });
    expect(codeProjectAccessMessage(access)).toBeNull();
  });

  it('names what a narrowed connection lacks, in the Connectors page words', () => {
    const access = codeProjectAccessOf({
      requested_scopes: ['account', 'repository', 'pullrequest'],
      granted_scopes: ALL,
    });
    expect(access.connected).toBe(true);
    expect(access.ok).toBe(false);
    expect(access.missingScopes).toEqual(['repository:write', 'pullrequest:write']);
    expect(access.missingOptions).toEqual([
      'Create branches & commit files',
      'Create & act on pull requests',
    ]);
    expect(codeProjectAccessMessage(access)).toBe(
      'Your Bitbucket connection does not carry “Create branches & commit files” and “Create & act on pull requests”. Reconnect Bitbucket on the Connectors page with those enabled to make code projects.'
    );
  });

  it('says "that" for a single missing checkbox', () => {
    const access = codeProjectAccessOf({
      requested_scopes: ['repository', 'repository:write'],
      granted_scopes: null,
    });
    expect(codeProjectAccessMessage(access)).toBe(
      'Your Bitbucket connection does not carry “Create & act on pull requests”. Reconnect Bitbucket on the Connectors page with that enabled to make code projects.'
    );
  });
});

describe('scopeOptionLabels', () => {
  it('lists each checkbox once, in catalog order, ignoring unknown scopes', () => {
    expect(scopeOptionLabels(['pullrequest:write', 'repository', 'project', 'nope'])).toEqual([
      'Read repositories & code',
      'Create & act on pull requests',
    ]);
  });
});
