/**
 * A migration runs where the workspace does not: scripts/build-migrations.js
 * compiles each numbered migration on its own (`bundle: false`), and the
 * migrate image (docker/Dockerfile, `migrate`) ships those files with the
 * database package's installed dependencies and nothing else. A
 * `@renkei/*` workspace package is TypeScript source the image does not
 * hold, so a migration importing one fails to start with "Cannot find
 * module" — after every test passed. Migrations import `kysely`, Node
 * built-ins, or a published package @renkei/db depends on; anything shared
 * they need, they keep a copy of.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMigrationFile } from './migrations/migration-files';

const DIR = join(__dirname, 'migrations');
const migrations = readdirSync(DIR).filter(isMigrationFile);

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1]
  );
}

describe('migrations are self-contained', () => {
  it('finds the migrations', () => {
    expect(migrations.length).toBeGreaterThan(100);
  });

  it('no migration imports a workspace package or a module outside the migrations', () => {
    const offending = migrations.flatMap((name) =>
      importsOf(readFileSync(join(DIR, name), 'utf8'))
        .filter((specifier) => specifier.startsWith('@renkei/') || specifier.startsWith('..'))
        .map((specifier) => `${name}: ${specifier}`)
    );
    expect(offending).toEqual([]);
  });
});
