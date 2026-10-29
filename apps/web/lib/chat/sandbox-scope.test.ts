import { sandboxScopeOf } from './sandbox-scope';

describe('sandboxScopeOf', () => {
  it('gives a plain chat its own scratch space, in a project or not', () => {
    expect(sandboxScopeOf({ id: 'c1' }, null)).toBe('chat:c1');
    expect(sandboxScopeOf({ id: 'c1' }, { id: 'p1', kind: 'chat' })).toBe('chat:c1');
  });

  it('gives every chat of one code project that project’s, and no other project’s', () => {
    expect(sandboxScopeOf({ id: 'c1' }, { id: 'p1', kind: 'code' })).toBe('project:p1');
    expect(sandboxScopeOf({ id: 'c2' }, { id: 'p1', kind: 'code' })).toBe('project:p1');
    expect(sandboxScopeOf({ id: 'c3' }, { id: 'p2', kind: 'code' })).toBe('project:p2');
  });
});
