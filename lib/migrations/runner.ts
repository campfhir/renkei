import { Migrator, FileMigrationProvider } from 'kysely';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getDatabase } from '@/lib/db';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  const db = getDatabase();

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs: await import('fs').then((m) => m.promises),
      path: await import('path'),
      migrationFolder: resolve(__dirname),
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
