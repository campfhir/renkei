/**
 * The validators are the only thing between a model's tool arguments and
 * a path, a ref or a variable name the worker will hand to the filesystem,
 * git or a shell — so each refusal here is a boundary a test should pin.
 */
import {
  clipOutput,
  execUidFor,
  execTimeoutMs,
  EXEC_MAX_TIMEOUT_MS,
  EXEC_UID_BASE,
  EXEC_UID_SPAN,
  looksBinary,
  validateCommand,
  validateEnvName,
  validateEnvValue,
  validateGitRef,
  validateGlob,
  validateRepoFullName,
  validateWorkspacePath,
} from './workspaces';

describe('validateWorkspacePath', () => {
  it('normalizes a relative path', () => {
    expect(validateWorkspacePath('./src//lib/../lib/a.ts')).toEqual({
      ok: false,
      message: expect.any(String),
    });
    expect(validateWorkspacePath('./src//lib/a.ts/')).toEqual({ ok: true, path: 'src/lib/a.ts' });
    expect(validateWorkspacePath('')).toEqual({ ok: true, path: '' });
    expect(validateWorkspacePath('.')).toEqual({ ok: true, path: '' });
  });

  it('refuses escapes, absolutes and control characters', () => {
    expect(validateWorkspacePath('../etc/passwd').ok).toBe(false);
    expect(validateWorkspacePath('src/../../x').ok).toBe(false);
    expect(validateWorkspacePath('/etc/passwd').ok).toBe(false);
    expect(validateWorkspacePath('C:/x').ok).toBe(false);
    expect(validateWorkspacePath('a\\b').ok).toBe(false);
    expect(validateWorkspacePath('a\0b').ok).toBe(false);
  });

  it('keeps writes out of .git', () => {
    expect(validateWorkspacePath('.git/config', { forWrite: true }).ok).toBe(false);
    expect(validateWorkspacePath('.git/config').ok).toBe(true);
    expect(validateWorkspacePath('.gitignore', { forWrite: true }).ok).toBe(true);
  });
});

describe('validateGitRef', () => {
  it('accepts ordinary branch names', () => {
    expect(validateGitRef('main')).toEqual({ ok: true, ref: 'main' });
    expect(validateGitRef('feature/PROJ-12_fix.v2')).toEqual({
      ok: true,
      ref: 'feature/PROJ-12_fix.v2',
    });
  });

  it('refuses names that could read as options or ref-specs', () => {
    for (const bad of [
      '',
      '-x',
      '--force',
      'a..b',
      'a b',
      'a:b',
      'a^',
      'a~1',
      'x.lock',
      'a//b',
      '/a',
      'a/',
      'a@{1}',
    ]) {
      expect(validateGitRef(bad).ok).toBe(false);
    }
  });
});

describe('validateRepoFullName', () => {
  it('splits workspace/repo', () => {
    expect(validateRepoFullName('acme/billing-service')).toEqual({
      ok: true,
      fullName: 'acme/billing-service',
      workspace: 'acme',
      repoSlug: 'billing-service',
    });
  });

  it('refuses anything else', () => {
    for (const bad of ['acme', 'acme/', '/repo', 'a/b/c', '../x', 'acme/..', '-a/b', 'a/b c']) {
      expect(validateRepoFullName(bad).ok).toBe(false);
    }
  });
});

describe('environment variables', () => {
  it('accepts shell-style names and refuses the reserved ones', () => {
    expect(validateEnvName('NPM_TOKEN')).toEqual({ ok: true, name: 'NPM_TOKEN' });
    expect(validateEnvName('_X1')).toEqual({ ok: true, name: '_X1' });
    for (const bad of [
      'npm_token',
      '1ABC',
      'A-B',
      'PATH',
      'LD_PRELOAD',
      'GIT_CONFIG_KEY_0',
      'RENKEI_X',
      'HOME',
    ]) {
      expect(validateEnvName(bad).ok).toBe(false);
    }
  });

  it('bounds values', () => {
    expect(validateEnvValue('abc').ok).toBe(true);
    expect(validateEnvValue('').ok).toBe(false);
    expect(validateEnvValue('a\0b').ok).toBe(false);
    expect(validateEnvValue('x'.repeat(9_000)).ok).toBe(false);
  });
});

describe('commands and output', () => {
  it('bounds a command and its timeout', () => {
    expect(validateCommand('pnpm test').ok).toBe(true);
    expect(validateCommand('   ').ok).toBe(false);
    expect(execTimeoutMs(undefined)).toBe(120_000);
    expect(execTimeoutMs(5_000)).toBe(5_000);
    expect(execTimeoutMs(10)).toBe(1_000);
    expect(execTimeoutMs(999_999_999)).toBe(EXEC_MAX_TIMEOUT_MS);
  });

  it('keeps the head and tail of long output', () => {
    const long = 'a'.repeat(500) + 'b'.repeat(500);
    const clipped = clipOutput(long, 200);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text.startsWith('a'.repeat(80))).toBe(true);
    expect(clipped.text.endsWith('b'.repeat(120))).toBe(true);
    expect(clipped.text).toContain('characters omitted');
    expect(clipOutput('short', 200)).toEqual({ text: 'short', clipped: false });
  });

  it('spots a binary', () => {
    expect(looksBinary(new TextEncoder().encode('hello\nworld'))).toBe(false);
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBe(true);
  });
});

describe('globs', () => {
  it('defaults to everything and strips a leading ./', () => {
    expect(validateGlob('')).toEqual({ ok: true, glob: '**/*' });
    expect(validateGlob('./src/**/*.ts')).toEqual({ ok: true, glob: 'src/**/*.ts' });
    expect(validateGlob('../*').ok).toBe(false);
    expect(validateGlob('/etc/*').ok).toBe(false);
  });
});

describe('execUidFor', () => {
  it('is stable, unprivileged and spread', () => {
    const uid = execUidFor('t1', 'alice');
    expect(uid).toBe(execUidFor('t1', 'alice'));
    expect(uid).toBeGreaterThanOrEqual(EXEC_UID_BASE);
    expect(uid).toBeLessThan(EXEC_UID_BASE + EXEC_UID_SPAN);
    expect(execUidFor('t1', 'bob')).not.toBe(uid);
    expect(execUidFor('t2', 'alice')).not.toBe(uid);
  });
});
