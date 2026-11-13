import { templateEnv, idleRules } from './config';
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

describe('configuration', () => {
  it('hands every sandbox the SANDBOX_TEMPLATE_ENV_ variables under their own names', () => {
    expect(
      templateEnv({
        SANDBOX_TEMPLATE_ENV_DATABASE_URL: 'postgres://x',
        SANDBOX_TEMPLATE_ENV_: 'ignored',
        DATABASE_URL: 'postgres://orchestrator',
      })
    ).toEqual({ DATABASE_URL: 'postgres://x' });
  });

  it('suspends after 15 minutes and removes after 24 hours unless told otherwise', () => {
    expect(idleRules({})).toEqual({ idleSuspendMs: 900_000, idleDeleteMs: 86_400_000 });
    expect(idleRules({ SANDBOX_IDLE_SUSPEND_MINUTES: '5', SANDBOX_IDLE_DELETE_HOURS: '2' })).toEqual(
      { idleSuspendMs: 300_000, idleDeleteMs: 7_200_000 }
    );
    expect(() => idleRules({ SANDBOX_IDLE_SUSPEND_MINUTES: '120', SANDBOX_IDLE_DELETE_HOURS: '1' })).toThrow();
    expect(() => idleRules({ SANDBOX_IDLE_SUSPEND_MINUTES: 'soon' })).toThrow();
  });
});
