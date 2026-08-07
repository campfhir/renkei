import esbuild from 'esbuild';
import { readdirSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Entry point: runs migrations, resolves @/ aliases, bundles everything
await esbuild.build({
  entryPoints: [resolve(projectRoot, 'scripts/migrate.ts')],
  outfile: resolve(projectRoot, 'dist/migrate.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  alias: { '@': projectRoot },
  external: ['pg'],
  logLevel: 'info',
});

// Migration files themselves are loaded individually at runtime by Kysely's
// FileMigrationProvider (directory scan + dynamic import), so they must exist
// on disk as plain .js files rather than live inside the bundle above.
const migrationsSourceDir = resolve(projectRoot, 'lib/migrations');
const migrationEntryPoints = readdirSync(migrationsSourceDir)
  .filter((name) => /^\d.*\.ts$/.test(name))
  .map((name) => resolve(migrationsSourceDir, name));

await esbuild.build({
  entryPoints: migrationEntryPoints,
  outdir: resolve(projectRoot, 'dist/lib/migrations'),
  bundle: false,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  logLevel: 'info',
});

console.log('✓ Migrations compiled successfully');
