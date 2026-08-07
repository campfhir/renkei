import { readdirSync } from 'fs';
import { join } from 'path';

// Both are ESM and cannot be required here. Neither is reached by these cases:
// the list is static, and the no-database path returns before any query.
jest.mock('kysely', () => ({ sql: () => ({ execute: async () => ({ rows: [] }) }) }));
jest.mock('../client', () => ({ getDatabase: () => ({ ok: false, err: 'unused' }) }));

import { EXPECTED_MIGRATIONS, getMigrationStatus } from './status';

/**
 * The migration files on disk, by the name Kysely records in its ledger — the
 * filename without its extension.
 */
function migrationFilesOnDisk(): string[] {
  return readdirSync(join(__dirname))
    .filter((file) => /^\d{3}-.*\.ts$/.test(file))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

describe('EXPECTED_MIGRATIONS', () => {
  // Without this, adding 013 and forgetting to list it makes the status check
  // report a schema as up to date while the code expects a column that is not
  // there — the exact failure this module exists to catch.
  it('lists every migration file, and only those', () => {
    expect([...EXPECTED_MIGRATIONS].sort()).toEqual(migrationFilesOnDisk());
  });

  it('is in the order the files apply in', () => {
    expect(EXPECTED_MIGRATIONS).toEqual([...EXPECTED_MIGRATIONS].sort());
  });

  it('excludes the helpers that share the directory', () => {
    expect(EXPECTED_MIGRATIONS).not.toContain('runner');
    expect(EXPECTED_MIGRATIONS).not.toContain('status');
  });
});

describe('getMigrationStatus', () => {
  it('reports the check as failed when there is no database', async () => {
    // Distinguished from "up to date": an unknown schema is not a known-good one.
    await expect(getMigrationStatus()).resolves.toEqual({
      pending: [],
      applied: 0,
      error: 'Database unavailable',
    });
  });
});
