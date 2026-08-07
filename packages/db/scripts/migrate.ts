import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from '../src/migrations/runner';

// Resolve relative to this script, not the caller's cwd, so
// `pnpm --filter @renkei/db migrate` works from anywhere in the workspace.
const migrationsDir = process.env.MIGRATIONS_DIR
  ? resolve(process.env.MIGRATIONS_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../src/migrations');

async function main() {
  try {
    await runMigrations(migrationsDir);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

main();
