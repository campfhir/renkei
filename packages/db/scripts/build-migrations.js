import esbuild from 'esbuild';
import { readdirSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');

// Entry point: runs migrations, bundled with its dependencies. The CJS bundle
// turns import.meta.url into undefined, so the container must set
// MIGRATIONS_DIR (the Dockerfile migrate stage does) — the script's
// script-relative fallback only runs when the variable is absent.
await esbuild.build({
  entryPoints: [resolve(packageRoot, 'scripts/migrate.ts')],
  outfile: resolve(packageRoot, 'dist/migrate.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['pg'],
  logLevel: 'info',
});

// Migration files themselves are loaded individually at runtime by Kysely's
// FileMigrationProvider (directory scan + dynamic import), so they must exist
// on disk as plain .js files rather than live inside the bundle above.
const migrationsSourceDir = resolve(packageRoot, 'src/migrations');
const migrationEntryPoints = readdirSync(migrationsSourceDir)
  .filter((name) => /^\d.*\.ts$/.test(name))
  .map((name) => resolve(migrationsSourceDir, name));

await esbuild.build({
  entryPoints: migrationEntryPoints,
  outdir: resolve(packageRoot, 'dist/migrations'),
  bundle: false,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  logLevel: 'info',
});

console.log('✓ Migrations compiled successfully');
