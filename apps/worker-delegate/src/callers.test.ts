/**
 * The per-caller allow-list, pinned: the web app runs everything, a worker
 * runs what its call sites need and never a key-destroying or
 * token-minting op, an unknown name runs nothing, and the development key
 * is refused in production.
 */

import { callerMayRun, developmentKeyRefusal, CALLER_OPS, DEVELOPMENT_KEY } from './callers';

describe('callerMayRun', () => {
  it('lets the web app run every op', () => {
    for (const op of ['keys/shred', 'resource-key/open', 'api', 'forward/mirth/api', 'anything']) {
      expect(callerMayRun('web', op)).toBe(true);
    }
  });

  it('gives the queue worker its call sites and nothing destructive', () => {
    expect(callerMayRun('worker', 'resource-key/ensure')).toBe(true);
    expect(callerMayRun('worker', 'grant/describe')).toBe(true);
    expect(callerMayRun('worker', 'api')).toBe(true);
    expect(callerMayRun('worker', 'forward/fileshares/read')).toBe(true);
    expect(callerMayRun('worker', 'forward/fileshares/')).toBe(false);
    expect(callerMayRun('worker', 'forward/mirth/api')).toBe(false);
    for (const op of [
      'keys/enroll',
      'keys/shred',
      'keys/rotate',
      'keys/delegate',
      'resource-key/share',
      'resource-key/delete',
      'resource-key/open',
      'grant/delete',
      'oauth/exchange',
      'grant/git-ticket',
      'user-sealed/open',
    ]) {
      expect(callerMayRun('worker', op)).toBe(false);
    }
  });

  it('gives the agents worker the owner check and the prune, nothing else', () => {
    expect(callerMayRun('agents', 'keys/status')).toBe(true);
    expect(callerMayRun('agents', 'maintenance/prune-orphan-keys')).toBe(true);
    expect(callerMayRun('agents', 'keys/shred')).toBe(false);
    expect(callerMayRun('agents', 'resource-key/open')).toBe(false);
    expect(callerMayRun('agents', 'api')).toBe(false);
  });

  it('gives the sandbox and an unknown name nothing', () => {
    expect(callerMayRun('sandbox', 'keys/status')).toBe(false);
    expect(callerMayRun('nobody', 'keys/status')).toBe(false);
    expect(callerMayRun('default', 'keys/status')).toBe(false);
  });

  it('never lets a worker row widen into a web-only op, even if the list says so', () => {
    expect(CALLER_OPS.worker).not.toContain('keys/shred');
    expect(callerMayRun('worker', 'keys/shred')).toBe(false);
  });
});

describe('developmentKeyRefusal', () => {
  it('refuses the development key in production and nowhere else', () => {
    expect(developmentKeyRefusal([DEVELOPMENT_KEY], { NODE_ENV: 'production' })).toMatch(
      /development delegate key/
    );
    expect(
      developmentKeyRefusal(['real-key', DEVELOPMENT_KEY], { NODE_ENV: 'production' })
    ).not.toBeNull();
    expect(developmentKeyRefusal(['real-key'], { NODE_ENV: 'production' })).toBeNull();
    expect(developmentKeyRefusal([DEVELOPMENT_KEY], { NODE_ENV: 'development' })).toBeNull();
    expect(developmentKeyRefusal([DEVELOPMENT_KEY], {})).toBeNull();
  });
});
