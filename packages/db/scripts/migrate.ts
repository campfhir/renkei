import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from '../src/migrations/runner';
import { ensureRuntimeRoles } from '../src/roles';

// Resolve relative to this script, not the caller's cwd, so
// `pnpm --filter @renkei/db migrate` works from anywhere in the workspace.
const migrationsDir = process.env.MIGRATIONS_DIR
  ? resolve(process.env.MIGRATIONS_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../src/migrations');

async function main() {
  try {
    const migrated = await runMigrations(migrationsDir);
    if (!migrated.ok) {
      console.error('Migration failed:', migrated.err);
      process.exit(1);
    }
    // After the schema is current, so every table the roles cover exists.
    // A no-op unless RENKEI_RUNTIME_DB_USER / RENKEI_SANDBOX_DB_USER is set.
    const roles = await ensureRuntimeRoles();
    if (!roles.ok) {
      console.error('Database roles failed:', roles.err);
      process.exit(1);
    }
    if (roles.val.length > 0) console.log(`[Roles] ensured: ${roles.val.join(', ')}`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

main();
