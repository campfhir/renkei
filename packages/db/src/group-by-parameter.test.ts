/**
 * A repo-wide guard against one specific, twice-made mistake.
 *
 * Kysely binds every `${…}` in a raw fragment as its own parameter. So a
 * GROUP BY or ORDER BY that repeats a parameterised SELECT expression is NOT
 * the same expression to Postgres — it sees `AT TIME ZONE $2` against `AT TIME
 * ZONE $3`, or `->> $2` against `->> $3`, and rejects the query with "column
 * … must appear in the GROUP BY clause".
 *
 * It reads as correct, typechecks, and fails only against a real database
 * with real parameters — which is why it shipped twice: once in the usage
 * trend chart, once in the connectors page, where it left the page with no
 * watches at all.
 *
 * The fix both times was to name the expression once in the SELECT and group
 * by that alias. This test enforces it by shape.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ROOTS = ['apps/web/lib', 'apps/web/app', 'apps/worker/src', 'packages'];
const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage']);

function sourceFiles(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

/** `groupBy(sql`…`)` / `orderBy(sql`…`)` whose fragment interpolates a value. */
const OFFENDER = /\.(groupBy|orderBy)\(\s*sql`[^`]*\$\{[^`]*`/g;

describe('raw GROUP BY / ORDER BY fragments', () => {
  it('never repeat a parameterised expression', () => {
    const offences: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(ROOT, root))) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(OFFENDER)) {
          offences.push(`${file.replace(`${ROOT}/`, '')}: ${match[0].slice(0, 80)}`);
        }
      }
    }

    expect(offences).toEqual([]);
  });
});
