import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { resolve } from 'path';
import { getDatabase } from '@/lib/db';

export async function runMigrations(migrationsDir?: string) {
  const db = getDatabase();
  const migrationFolder = migrationsDir || resolve(process.cwd(), 'lib/migrations');

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
    throw error;
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
}
