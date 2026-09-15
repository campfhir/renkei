import {
  bitbucketScopesOf,
  codeProjectAccessMessage,
  codeProjectAccessOf,
  CODE_PROJECT_SCOPES,
  scopeOptionLabels,
} from './access';

const ALL = ['account', 'repository', 'repository:write', 'pullrequest', 'pullrequest:write'];

describe('bitbucketScopesOf', () => {
  it('narrows requested by granted when granted is known, else takes requested', () => {
    expect(
      bitbucketScopesOf({ requested_scopes: ['repository', 'pipeline'], granted_scopes: ALL })
    ).toEqual(['repository']);
    expect(
      bitbucketScopesOf({ requested_scopes: ['repository', 'pipeline'], granted_scopes: null })
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
