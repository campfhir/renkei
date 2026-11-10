/**
 * What the scope picker offers and the fine print under each box, for an
 * operator choosing the org's ceiling and for a person connecting their
 * own account.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import { optionFinePrint, visibleScopeGroups } from './scope-picker.model';

const GROUPS: ScopeGroup[] = [
  { id: 'read', label: 'Read' },
  { id: 'write', label: 'Write' },
  { id: 'admin', label: 'Admin' },
];

const option = (id: string, group: string, scopes: string[], userHint?: string): ScopeOption => ({
  id,
  group,
  scopes,
  label: id,
  hint: `${id} (operator words)`,
  ...(userHint ? { userHint } : {}),
  defaultChecked: true,
});

const OPTIONS = [
  option('mail', 'read', ['Mail.Read'], 'Read your email'),
  option('files', 'read', ['Files.Read', 'Sites.Read.All']),
  option('send', 'write', ['Mail.Send']),
  option('users', 'admin', ['User.Read.All']),
];

const shape = (groups: ReturnType<typeof visibleScopeGroups>) =>
  groups.map(({ group, options }) => [group.label, options.map((o) => o.id)]);

describe('the scope picker', () => {
  it('without a ceiling offers the whole catalog, grouped in catalog order', () => {
    expect(shape(visibleScopeGroups(GROUPS, OPTIONS))).toEqual([
      ['Read', ['mail', 'files']],
      ['Write', ['send']],
      ['Admin', ['users']],
    ]);
  });

  it('hides a capability the org withheld any one of its scopes from', () => {
    const groups = visibleScopeGroups(GROUPS, OPTIONS, ['Mail.Read', 'Files.Read', 'Mail.Send']);
    expect(shape(groups)).toEqual([
      ['Read', ['mail']],
      ['Write', ['send']],
    ]);
  });

  it('drops a group heading with nothing left under it', () => {
    expect(shape(visibleScopeGroups(GROUPS, OPTIONS, ['Mail.Send']))).toEqual([
      ['Write', ['send']],
    ]);
    expect(visibleScopeGroups(GROUPS, OPTIONS, [])).toEqual([]);
  });

  it('shows an operator the raw scope, or how many and which', () => {
    expect(optionFinePrint(OPTIONS[0], 'admin')).toEqual({
      scopes: 'Mail.Read',
      scopesTitle: 'Mail.Read',
      hint: 'mail (operator words)',
    });
    expect(optionFinePrint(OPTIONS[1], 'admin').scopes).toBe('2 scopes: Files.Read Sites.Read.All');
  });

  it('shows a person no scopes, and the plain-language hint where there is one', () => {
    expect(optionFinePrint(OPTIONS[0], 'user')).toMatchObject({
      scopes: null,
      hint: 'Read your email',
    });
    expect(optionFinePrint(OPTIONS[2], 'user').hint).toBe('send (operator words)');
  });
});
