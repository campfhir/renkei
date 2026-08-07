import { readdirSync } from 'fs';
import { isMigrationFile } from './migration-files';

/**
 * Regression: running migrations from source used to import every file in
 * this directory — including status.test.ts, which references jest at module
 * scope and crashed the migrate CLI. The filter must accept exactly the
 * numbered migration files and nothing else that lives here.
 */
describe('isMigrationFile', () => {
  it('rejects the helpers and tests that share the directory', () => {
    expect(isMigrationFile('runner.ts')).toBe(false);
    expect(isMigrationFile('status.ts')).toBe(false);
    expect(isMigrationFile('status.test.ts')).toBe(false);
    expect(isMigrationFile('migration-files.ts')).toBe(false);
    expect(isMigrationFile('migration-files.test.ts')).toBe(false);
  });

  it('accepts every numbered migration on disk, compiled or source', () => {
    const numbered = readdirSync(__dirname).filter((f) => /^\d/.test(f));
    expect(numbered.length).toBeGreaterThan(0);
    for (const file of numbered) {
      expect(isMigrationFile(file)).toBe(true);
    }
    expect(isMigrationFile('014-next-thing.cjs')).toBe(true);
  });
});
