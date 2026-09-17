/**
 * narrowedScopes backs both Zoom and Bitbucket's "requested ∩ granted, or
 * requested alone when granted is unknown" rule, for the tool registry
 * and the code-project access check alike. This pins the case that
 * motivated it: a real Bitbucket grant whose token response reported
 * granted scopes under a naming scheme (`read:repository:bitbucket-legacy`)
 * that shares nothing with the classic names (`repository`, `account`, …)
 * this app requests and stores — which used to intersect to an empty
 * array and silently deregister every Bitbucket tool for an otherwise
 * healthy connection.
 */

import { narrowedScopes } from './narrowed-scopes';

describe('narrowedScopes', () => {
  it('falls back to requested alone when granted is in an unrecognized vocabulary', () => {
    const requested = [
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
    ];
    // Bitbucket's actual reported granted_scopes for a real, healthy grant.
    const granted = [
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

    expect(narrowedScopes(requested, granted)).toEqual(requested);
  });

  it('falls back to requested alone when granted is null (unknown/opaque token)', () => {
    expect(narrowedScopes(['repository', 'account'], null)).toEqual(['repository', 'account']);
  });

  it('falls back to requested alone when granted is undefined (no grant row)', () => {
    expect(narrowedScopes(['repository', 'account'], undefined)).toEqual(['repository', 'account']);
  });

  it('intersects when granted is recognized and genuinely narrower', () => {
    const requested = ['repository', 'repository:write', 'pullrequest', 'account'];
    const granted = ['repository', 'account'];

    expect(narrowedScopes(requested, granted)).toEqual(['repository', 'account']);
  });

  it('keeps a partially-recognized granted list as the strict intersection', () => {
    // Real narrowing plus one entry in an unrecognized shape should still
    // narrow, not fall back — recognizing even one entry is enough to
    // trust the rest of the list.
    const requested = ['repository', 'repository:write', 'account'];
    const granted = ['repository', 'account', 'read:repository:bitbucket-legacy'];

    expect(narrowedScopes(requested, granted)).toEqual(['repository', 'account']);
  });
});
