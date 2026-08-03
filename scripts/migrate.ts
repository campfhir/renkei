import { resolve } from 'path';
import { runMigrations } from '@/lib/migrations/runner';

const migrationsDir = process.env.MIGRATIONS_DIR ? resolve(process.env.MIGRATIONS_DIR) : undefined;

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
