/**
 * One copy of each guard (./index.ts): a local `isRecord` in some module
 * is how there came to be 170 of them, in three slightly different
 * meanings (one let arrays through). Every app and package is scanned for
 * a definition of a name this package exports, or of the aliases those
 * copies went by; import it from '@renkei/guards' instead.
 *
 * A module whose same-named function genuinely means something else goes
 * in ALLOWED with the reason.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');

const NAMES = ['isRecord', 'asRecord', 'recordOrNull', 'isString', 'isPlainObject', 'plainObject'];

/** Repo-relative path → why its definition is not a copy. */
const ALLOWED: Record<string, string> = {
  'packages/connector-mcp/src/client.ts':
    'its asRecord reads a JSON-RPC response (isRpcResponse), not any record',
};

const DEFINITION = new RegExp(
  String.raw`^\s*(export\s+)?(function\s+(${NAMES.join('|')})\b|const\s+(${NAMES.join('|')})\s*=)`,
  'm'
);

const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '.next', 'generated']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) return [];
    const child = join(dir, entry.name);
    if (entry.isDirectory()) return sources(child);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [child]
      : [];
  });
}

const scanned = ['apps', 'packages']
  .flatMap((group) => sources(join(REPO, group)))
  .map((path) => relative(REPO, path).split(sep).join('/'))
  .filter((path) => !path.startsWith('packages/guards/'))
  // A migration is compiled on its own and run by the migrate image, which
  // holds no workspace package sources: it keeps its own copy
  // (packages/db/src/migrations-self-contained.test.ts).
  .filter((path) => !/^packages\/db\/src\/migrations\/\d{3}-/.test(path));

describe('the guards have one home', () => {
  it('scans the repository', () => {
    expect(scanned.length).toBeGreaterThan(100);
  });

  it('no module defines its own copy', () => {
    const copies = scanned.filter(
      (path) => !ALLOWED[path] && DEFINITION.test(readFileSync(join(REPO, path), 'utf8'))
    );
    expect(copies).toEqual([]);
  });
});
