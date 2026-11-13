import { sandboxApiKey } from './keys';
import { isRouteKey, sandboxKindOf } from './scope';

describe('a sandbox scope', () => {
  it('is a person unless its key says otherwise', () => {
    expect(sandboxKindOf('auth0|ann')).toBe('user');
    expect(sandboxKindOf('agent:7')).toBe('agent');
    expect(sandboxKindOf('code-project:7')).toBe('project');
    expect(sandboxKindOf('chat-project:7')).toBe('project');
    expect(sandboxKindOf('system')).toBe('system');
  });

  it('is printable text of a sane length', () => {
    expect(isRouteKey('auth0|ann')).toBe(true);
    expect(isRouteKey('')).toBe(false);
    expect(isRouteKey('a\u0000b')).toBe(false);
    expect(isRouteKey('x'.repeat(513))).toBe(false);
    expect(isRouteKey(7)).toBe(false);
  });
});

describe('a sandbox key', () => {
  it('is the same every time for one sandbox and different for another', () => {
    expect(sandboxApiKey('master', 'a')).toBe(sandboxApiKey('master', 'a'));
    expect(sandboxApiKey('master', 'a')).not.toBe(sandboxApiKey('master', 'b'));
    expect(sandboxApiKey('master', 'a')).not.toBe(sandboxApiKey('other', 'a'));
  });
});
