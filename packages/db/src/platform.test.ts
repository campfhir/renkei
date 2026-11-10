/**
 * Boot brings the log tables current without queueing for their locks:
 * the DDL runs only when the catalogs say something is missing.
 */

import { migrateLogTables, type LogTableMigrator } from './platform';

function fakeAdapter(applied: boolean[]) {
  const calls = { migrate: 0 };
  const adapter: LogTableMigrator = {
    migrationStatus: () =>
      Promise.resolve(applied.map((isApplied, i) => ({ name: `00${i}`, applied: isApplied }))),
    migrate: () => {
      calls.migrate += 1;
      return Promise.resolve();
    },
  };
  return { adapter, calls };
}

describe('migrateLogTables', () => {
  it('runs no DDL when every log table and index is already there', async () => {
    const { adapter, calls } = fakeAdapter([true, true, true, true]);
    await expect(migrateLogTables(adapter)).resolves.toBe(false);
    expect(calls.migrate).toBe(0);
  });

  it('migrates when a newer bored-logs brings a table this database lacks', async () => {
    const { adapter, calls } = fakeAdapter([true, true, true, false]);
    await expect(migrateLogTables(adapter)).resolves.toBe(true);
    expect(calls.migrate).toBe(1);
  });
});
