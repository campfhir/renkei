import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { resolve } from 'path';
import { getDatabase } from '@/lib/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export async function runMigrations(migrationsDir?: string): Promise<Result<void, 'MIGRATION_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('MIGRATION_ERROR' as const);
  const db = dbResult.val;
  const migrationFolder = migrationsDir || resolve(process.cwd(), 'lib/migrations');

  try {
    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs: await import('fs').then((m) => m.promises),
        path: await import('path'),
        migrationFolder,
      }),
    });

    console.log('[Migrations] Running migrations...');
    const { error, results } = await migrator.migrateToLatest();

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_error) {
    return err('MIGRATION_ERROR' as const);
  }
}
