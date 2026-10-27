/**
 * The data store seam, held statically across the repo: outside this
 * package, code reads and writes through `getDataStore()` and never sees
 * the database — no handle, no Kysely, no SQL. The web app, every worker,
 * every shared package, their scripts, their tests and test-support are
 * scanned: a test seeds its rows with the store methods the application
 * writes them with. Only the e2e directories are left out (the Playwright
 * suite drives a running deployment from outside it).
 *
 * A file that genuinely needs the pg handle goes in ALLOWED with the
 * reason, not around this test.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = join(__dirname, '..', '..', '..', '..');

/** Repo-relative paths that may reach the database directly, and why. */
const ALLOWED: Record<string, string> = {};

const FORBIDDEN: [RegExp, string][] = [
  [/\bgetDatabase\s*\(/, 'getDatabase()'],
  [/\bgetPool\s*\(/, 'getPool()'],
  [/from\s+['"]kysely['"]/, "an import from 'kysely'"],
  [/from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\)/, "an import of 'pg'"],
  [/\bKysely</, 'a Kysely handle'],
  [/\bsql`/, 'raw sql``'],
  [/\.(selectFrom|insertInto|updateTable|deleteFrom)\(/, 'a Kysely query builder'],
  [/\bcontext\.db\b/, 'the request context db getter'],
  [/from\s+['"]@renkei\/db\/[^'"]+['"]/, 'a deep import past @renkei/db'],
];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'e2e', 'coverage']);

function isSource(name: string): boolean {
  return /\.(ts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts');
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) return [];
    const child = join(dir, entry.name);
    if (entry.isDirectory()) return sources(child);
    return isSource(entry.name) ? [child] : [];
  });
}

/** Every workspace directory but this package. */
function workspaces(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(REPO, group))
      .map((name) => join(REPO, group, name))
      .filter((path) => statSync(path).isDirectory() && path !== join(REPO, 'packages', 'db'))
  );
}

/** Lines of code, comments dropped (line and block comments; good enough for these patterns). */
function codeLines(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'));
}

describe('data store seam', () => {
  const files = workspaces().flatMap(sources);

  it('scans the apps, workers and packages', () => {
    const scanned = new Set(
      files.map((file) => relative(REPO, file).split(sep).slice(0, 2).join('/'))
    );
    for (const workspace of ['apps/web', 'apps/worker', 'apps/worker-agents', 'packages/queue']) {
      expect(scanned.has(workspace)).toBe(true);
    }
    expect(files.length).toBeGreaterThan(1000);
  });

  it('no code outside packages/db reaches the database directly', () => {
    const found: string[] = [];
    for (const file of files) {
      const path = relative(REPO, file).split(sep).join('/');
      if (path in ALLOWED) continue;
      codeLines(readFileSync(file, 'utf8')).forEach((line, index) => {
        for (const [pattern, what] of FORBIDDEN) {
          if (pattern.test(line)) found.push(`${path}:${index + 1} uses ${what}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  it('every allowed file still exists', () => {
    for (const path of Object.keys(ALLOWED)) {
      expect(() => readFileSync(join(REPO, path))).not.toThrow();
    }
  });
});
