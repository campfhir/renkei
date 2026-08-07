import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import { resolve } from 'path';
import { getDatabase } from '../client';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

import { isMigrationFile } from './migration-files';

/**
 * Loads only numbered migration files (001-init.ts, …). Kysely's
 * FileMigrationProvider imports EVERY file in the folder, which detonates on
 * the colocated helpers — status.test.ts references jest at module scope —
 * the moment migrations run from source instead of the compiled bundle
 * (whose build step already applies this same filter).
 */
class NumberedMigrationProvider implements MigrationProvider {
  constructor(private readonly folder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const { pathToFileURL } = await import('url');

    const migrations: Record<string, Migration> = {};
    const files = (await fs.readdir(this.folder)).filter(isMigrationFile).sort();
    for (const file of files) {
      const module: Migration = await import(
        pathToFileURL(path.join(this.folder, file)).href
      );
      migrations[file.replace(/\.[^.]+$/, '')] = module;
    }
    return migrations;
  }
}

export async function runMigrations(migrationsDir?: string): Promise<Result<void, 'MIGRATION_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('MIGRATION_ERROR' as const);
  const db = dbResult.val;
  const migrationFolder = migrationsDir || resolve(process.cwd(), 'src/migrations');

  const migrator = new Migrator({
    db,
    provider: new NumberedMigrationProvider(migrationFolder),
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
