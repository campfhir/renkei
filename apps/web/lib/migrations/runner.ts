import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { resolve } from 'path';
import { getDatabase } from '@/lib/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export async function runMigrations(migrationsDir?: string): Promise<Result<void, 'MIGRATION_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('MIGRATION_ERROR' as const);
  const db = dbResult.val;
  const migrationFolder = migrationsDir || resolve(process.cwd(), 'lib/migrations');

  const fsResult = await wrapAsync(() => import('fs').then((m) => m.promises), 'MIGRATION_ERROR' as const);
  if (!fsResult.ok) return fsResult;
  const fs = fsResult.val;

  const pathResult = await wrapAsync(() => import('path'), 'MIGRATION_ERROR' as const);
  if (!pathResult.ok) return pathResult;

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path: pathResult.val,
      migrationFolder,
    }),
  });

  console.log('[Migrations] Running migrations...');
  const migrateResult = await wrapAsync(() => migrator.migrateToLatest(), 'MIGRATION_ERROR' as const);

  if (!migrateResult.ok) {
    console.error('[Migrations] Error running migrations');
    return migrateResult;
  }

  const { error, results } = migrateResult.val;

  if (error) {
    console.error('[Migrations] Error running migrations:', error);
    return err('MIGRATION_ERROR' as const);
  }

  if (results?.length === 0) {
    console.log('[Migrations] No migrations to run');
  } else {
    results?.forEach((result) => {
      if (result.status === 'Success') {
        console.log(`[Migrations] ✓ ${result.migrationName}`);
      } else {
        console.log(`[Migrations] ✗ ${result.migrationName}: ${result.status}`);
      }
    });
  }

  console.log('[Migrations] Done');
  return ok();
}
