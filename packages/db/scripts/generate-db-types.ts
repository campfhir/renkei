/**
 * Generate TypeScript types from database schema using kysely-codegen.
 * Run: pnpm tsx scripts/generate-db-types.ts
 */

import { Cli } from 'kysely-codegen';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

async function generateTypes() {
  const cli = new Cli();
  await cli.generate({
    dialect: 'postgres',
    outFile: './lib/db.types.ts',
    url: DATABASE_URL,
  });

  console.log('✓ Generated database types at lib/db.types.ts');
}

generateTypes().catch(console.error);
