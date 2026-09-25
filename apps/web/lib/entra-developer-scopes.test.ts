/**
 * The Entra Developer scope catalog: every option names real delegated
 * Graph permissions in the form Graph's scope parameter takes (short names,
 * never resource-qualified URIs), the write bundle carries its read scope
 * so a "manage" grant still registers the read tools, and the default
 * ceiling is the union with the structural scopes, each once.
 */

import {
  DEFAULT_ENTRA_DEVELOPER_SCOPES,
  ENTRA_DEVELOPER_REQUIRED_SCOPES,
  ENTRA_DEVELOPER_SCOPE_GROUPS,
  ENTRA_DEVELOPER_SCOPE_OPTIONS,
} from './entra-developer-scopes';

describe('ENTRA_DEVELOPER_SCOPE_OPTIONS', () => {
  it('names only short delegated Graph permissions, each in a known group', () => {
    const groups = new Set(ENTRA_DEVELOPER_SCOPE_GROUPS.map((group) => group.id));
    for (const option of ENTRA_DEVELOPER_SCOPE_OPTIONS) {
      expect(groups.has(option.group)).toBe(true);
      for (const scope of option.scopes) {
        expect(scope).toMatch(/^[A-Z][A-Za-z]+(\.[A-Za-z]+)+$/);
      }
    }
  });

  it('carries the read scope inside the write bundle', () => {
    const write = ENTRA_DEVELOPER_SCOPE_OPTIONS.find((o) => o.id === 'Application.ReadWrite.All');
    expect(write?.scopes).toEqual(['Application.Read.All', 'Application.ReadWrite.All']);
  });

  it('defaults to every option plus the structural scopes, without duplicates', () => {
    const scopes = DEFAULT_ENTRA_DEVELOPER_SCOPES.split(' ');
    expect(new Set(scopes).size).toBe(scopes.length);
    for (const required of ENTRA_DEVELOPER_REQUIRED_SCOPES) expect(scopes).toContain(required);
    expect(scopes).toContain('AppRoleAssignment.ReadWrite.All');
    expect(scopes).toContain('Group.Read.All');
  });
});
