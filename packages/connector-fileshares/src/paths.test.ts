import {
  childPath,
  isBoundaryPrefix,
  joinUnder,
  normalizePath,
  parentPath,
  windowsToUnix,
} from './paths';

function expectOk(result: { ok: boolean; val?: string }, value: string): void {
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.val).toBe(value);
}

function expectErr(result: { ok: boolean; err?: { type?: string } }, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.err?.type).toBe(code);
}

describe('normalizePath', () => {
  it('canonicalizes ordinary paths', () => {
    expectOk(normalizePath('/foo/bar'), '/foo/bar');
    expectOk(normalizePath('foo/bar'), '/foo/bar');
    expectOk(normalizePath('/foo/bar/'), '/foo/bar');
    expectOk(normalizePath('//foo///bar//'), '/foo/bar');
    expectOk(normalizePath('/foo/./bar/.'), '/foo/bar');
  });

  it('treats empty and root as the root', () => {
    expectOk(normalizePath(''), '/');
    expectOk(normalizePath('/'), '/');
    expectOk(normalizePath('.'), '/');
    expectOk(normalizePath('///'), '/');
  });

  it('folds backslashes into separators', () => {
    expectOk(normalizePath('\\foo\\bar'), '/foo/bar');
    expectOk(normalizePath('foo\\bar/baz'), '/foo/bar/baz');
  });

  // The traversal corpus: every spelling of ".." must be rejected, never
  // resolved — including ones that only become ".." after backslash folding.
  it.each([
    '..',
    '/..',
    '../',
    '/foo/../bar',
    'foo/..',
    '/foo/bar/..',
    'a/../..',
    '....//..',
    '..\\foo',
    'foo\\..\\bar',
    '/foo/..\\bar',
    './..',
  ])('rejects traversal in %j', (input) => {
    expectErr(normalizePath(input), 'PATH_TRAVERSAL');
  });

  it('does not mistake dot-prefixed names for traversal', () => {
    expectOk(normalizePath('/foo/..bar'), '/foo/..bar');
    expectOk(normalizePath('/foo/...'), '/foo/...');
    expectOk(normalizePath('/.hidden'), '/.hidden');
  });

  it('rejects NUL bytes', () => {
    expectErr(normalizePath('/foo\0bar'), 'INVALID_PATH');
  });
});

describe('windowsToUnix', () => {
  it('drops the UNC server and share components', () => {
    expect(windowsToUnix('\\\\fileserver\\accounting\\2024\\reports')).toBe('/2024/reports');
    expect(windowsToUnix('\\\\fileserver\\accounting')).toBe('/');
    expect(windowsToUnix('\\\\fileserver\\accounting\\')).toBe('/');
  });

  it('drops drive letters', () => {
    expect(windowsToUnix('C:\\projects\\renkei')).toBe('/projects/renkei');
    expect(windowsToUnix('c:')).toBe('/');
  });

  it('passes plain paths through as slashes', () => {
    expect(windowsToUnix('reports\\q4')).toBe('reports/q4');
    expect(windowsToUnix('/already/unix')).toBe('/already/unix');
  });
});

describe('isBoundaryPrefix', () => {
  it('matches only at directory boundaries', () => {
    expect(isBoundaryPrefix('/foo', '/foo', false)).toBe(true);
    expect(isBoundaryPrefix('/foo', '/foo/bar', false)).toBe(true);
    expect(isBoundaryPrefix('/foo', '/foobar', false)).toBe(false);
    expect(isBoundaryPrefix('/foo/bar', '/foo', false)).toBe(false);
  });

  it('root covers everything', () => {
    expect(isBoundaryPrefix('/', '/', false)).toBe(true);
    expect(isBoundaryPrefix('/', '/anything/below', false)).toBe(true);
  });

  it('folds case only when told to', () => {
    expect(isBoundaryPrefix('/Foo', '/foo/bar', true)).toBe(true);
    expect(isBoundaryPrefix('/Foo', '/foo/bar', false)).toBe(false);
  });
});

describe('joinUnder', () => {
  it('joins a relative path under the root', () => {
    expectOk(joinUnder('/base', '/foo/bar'), '/base/foo/bar');
    expectOk(joinUnder('/', '/foo'), '/foo');
    expectOk(joinUnder('/base', '/'), '/base');
    expectOk(joinUnder('/', '/'), '/');
  });

  it('refuses traversal in either part', () => {
    expectErr(joinUnder('/base', '/foo/../../etc'), 'PATH_TRAVERSAL');
    expectErr(joinUnder('/base/..', '/foo'), 'PATH_TRAVERSAL');
  });
});

describe('parentPath / childPath', () => {
  it('walks up and down consistently', () => {
    expect(parentPath('/foo/bar')).toBe('/foo');
    expect(parentPath('/foo')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(childPath('/', 'foo')).toBe('/foo');
    expect(childPath('/foo', 'bar')).toBe('/foo/bar');
  });
});
