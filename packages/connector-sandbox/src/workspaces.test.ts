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
  parseCleanOutput,
  STASH_MESSAGE_MAX_CHARS,
  validateCommand,
  validateGitLogFilter,
  validateGitRange,
  validateGitRevision,
  validateSparsePaths,
  validateStashIndex,
  validateStashMessage,
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

describe('validateGitRevision and validateGitRange', () => {
  it('takes branches, remote-tracking names, heads, hashes, and stepped forms', () => {
    for (const good of [
      'main',
      'origin/main',
      'HEAD',
      'FETCH_HEAD',
      'abc1234',
      'HEAD~3',
      'main^2~1',
    ]) {
      expect(validateGitRevision(good)).toEqual({ ok: true, revision: good });
    }
    expect(validateGitRevision(' main ')).toEqual({ ok: true, revision: 'main' });
  });

  it('refuses options, ranges, reflog expressions and empties', () => {
    for (const bad of ['', '-f', '--hard', 'a..b', 'HEAD@{1}', 'a:b', '~', 'x..', 'a b']) {
      expect(validateGitRevision(bad).ok).toBe(false);
    }
  });

  it('reads a range as two revisions, or one revision, defaulting to HEAD', () => {
    expect(validateGitRange('')).toEqual({ ok: true, range: 'HEAD' });
    expect(validateGitRange('main..feature')).toEqual({ ok: true, range: 'main..feature' });
    expect(validateGitRange('v1...v2')).toEqual({ ok: true, range: 'v1...v2' });
    expect(validateGitRange('origin/main')).toEqual({ ok: true, range: 'origin/main' });
    expect(validateGitRange('a..b..c').ok).toBe(false);
    expect(validateGitRange('..b').ok).toBe(false);
    expect(validateGitRange('--all').ok).toBe(false);
  });
});

describe('stashes, sparse paths and clean output', () => {
  it('names a stash by position and bounds its message', () => {
    expect(validateStashIndex(undefined)).toEqual({ ok: true, index: 0 });
    expect(validateStashIndex(2)).toEqual({ ok: true, index: 2 });
    expect(validateStashIndex(-1).ok).toBe(false);
    expect(validateStashIndex(1.5).ok).toBe(false);
    expect(validateStashMessage(' wip ')).toEqual({ ok: true, message: 'wip' });
    expect(validateStashMessage('x'.repeat(STASH_MESSAGE_MAX_CHARS + 1)).ok).toBe(false);
  });

  it('keeps sparse paths relative, non-empty, unique, and out of .git', () => {
    expect(validateSparsePaths(['apps/web', './apps/web/', 'packages'])).toEqual({
      ok: true,
      paths: ['apps/web', 'packages'],
    });
    expect(validateSparsePaths([]).ok).toBe(false);
    expect(validateSparsePaths(['']).ok).toBe(false);
    expect(validateSparsePaths(['../x']).ok).toBe(false);
    expect(validateSparsePaths(['.git/hooks']).ok).toBe(false);
    expect(validateSparsePaths('apps').ok).toBe(false);
  });

  it('reads what clean removed or would remove', () => {
    expect(
      parseCleanOutput('Would remove junk\nWould remove build/\nWould skip repository sub/\n')
    ).toEqual(['junk', 'build', 'sub']);
    expect(parseCleanOutput('Removing a.log\n')).toEqual(['a.log']);
    expect(parseCleanOutput('')).toEqual([]);
  });

  it('bounds a log filter to printable text', () => {
    expect(validateGitLogFilter(' fix ')).toEqual({ ok: true, filter: 'fix' });
    expect(validateGitLogFilter('')).toEqual({ ok: true, filter: '' });
    expect(validateGitLogFilter('a\nb').ok).toBe(false);
  });
});
