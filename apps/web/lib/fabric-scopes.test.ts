/**
 * The Fabric scope catalog: every option names Fabric's own delegated
 * permissions qualified by its resource (a Fabric token cannot carry a
 * Graph scope), every building bundle carries the workspace read it
 * resolves names with, and the default ceiling holds no Graph scope at all.
 */

import {
  DEFAULT_FABRIC_SCOPES,
  FABRIC_REQUIRED_SCOPES,
  FABRIC_SCOPE_GROUPS,
  FABRIC_SCOPE_OPTIONS,
  fabricScope,
  shortFabricScope,
} from './fabric-scopes';

describe('FABRIC_SCOPE_OPTIONS', () => {
  it('names only resource-qualified Fabric permissions, each in a known group', () => {
    const groups = new Set(FABRIC_SCOPE_GROUPS.map((group) => group.id));
    for (const option of FABRIC_SCOPE_OPTIONS) {
      expect(groups.has(option.group)).toBe(true);
      for (const scope of option.scopes) {
        expect(scope).toMatch(
          /^https:\/\/api\.fabric\.microsoft\.com\/[A-Z][A-Za-z]+(\.[A-Za-z]+)+$/
        );
      }
    }
  });

  it('carries the workspace read inside every notebook and pipeline bundle', () => {
    for (const option of FABRIC_SCOPE_OPTIONS.filter((o) => o.group === 'build')) {
      expect(option.scopes).toContain(fabricScope('Workspace.Read.All'));
    }
  });

  it('asks for nothing that changes workspaces: that goes through CI', () => {
    expect(DEFAULT_FABRIC_SCOPES.split(' ')).not.toContain(fabricScope('Workspace.ReadWrite.All'));
  });

  it('defaults to every option plus the identity scopes, once each, and nothing of Graph', () => {
    const scopes = DEFAULT_FABRIC_SCOPES.split(' ');
    expect(new Set(scopes).size).toBe(scopes.length);
    for (const required of FABRIC_REQUIRED_SCOPES) expect(scopes).toContain(required);
    expect(scopes).not.toContain('User.Read');
    expect(scopes).toContain(fabricScope('Notebook.ReadWrite.All'));
  });

  it('compares a token’s short scope names with the requested ones', () => {
    expect(shortFabricScope(fabricScope('Item.Read.All'))).toBe('Item.Read.All');
    expect(shortFabricScope('Item.Read.All')).toBe('Item.Read.All');
  });
});
