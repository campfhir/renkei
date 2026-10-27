/**
 * The data store seam, held statically: the web app's pages, layouts, API
 * routes and the library code they call read and write through
 * `getDataStore()`, never the database directly. The memory crawl
 * (e2e/memory/crawl.spec.ts) catches a page that reaches the database at
 * runtime; this catches any module, route handlers included, before it
 * runs.
 *
 * A file that genuinely needs the pg handle goes in ALLOWED with the
 * reason, not around this test.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..');

/** Repo-relative (to apps/web) paths that may hold the database handle, and why. */
const ALLOWED: Record<string, string> = {
  'instrumentation.ts': 'hands the pg handle to the bored-logs log adapter (infrastructure)',
  'lib/test-support/delegate.ts': 'test support for the *.db.test.ts suites',
};

const SCANNED = ['app', 'lib', 'components', 'hooks', 'instrumentation.ts', 'proxy.ts'];

const FORBIDDEN: [RegExp, string][] = [
  [/\bgetDatabase\s*\(/, 'getDatabase()'],
  [/\bgetPool\s*\(/, 'getPool()'],
  [/from\s+['"]kysely['"]/, "an import from 'kysely'"],
  [/\bKysely</, 'a Kysely handle'],
  [/\bsql`/, 'raw sql``'],
  [/\.(selectFrom|insertInto|updateTable|deleteFrom)\(/, 'a Kysely query builder'],
  [/\bcontext\.db\b/, 'the request context db getter'],
];

function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.split(sep).includes('e2e');
}

function sources(path: string): string[] {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return /\.tsx?$/.test(path) ? [path] : [];
  }
  return entries.flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sources(child);
    return /\.tsx?$/.test(entry.name) && !isTest(child) ? [child] : [];
  });
}

/** Lines of code, comments dropped (line and block comments; good enough for these patterns). */
function codeLines(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'));
}

describe('data store seam', () => {
  const files = SCANNED.flatMap((entry) => {
    try {
      return sources(join(ROOT, entry));
    } catch {
      return [];
    }
  });

  it('scans the app', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no page, route or library module reaches the database directly', () => {
    const found: string[] = [];
    for (const file of files) {
      const path = relative(ROOT, file).split(sep).join('/');
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
      expect(() => readFileSync(join(ROOT, path))).not.toThrow();
    }
  });
});
