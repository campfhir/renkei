/**
 * Whether the database schema is as new as the code expecting it.
 *
 * Migrations are run as a deliberate, separate step — the migrate service sits
 * behind a compose profile so that starting the gateway never applies them as a
 * side effect. The gap that leaves is an operator pulling new images and
 * starting the app without running it: the app boots, serves traffic, and the
 * mismatch first shows up as an opaque 500 to whoever tries to register an MCP
 * client, with `column "client_secret_hash" of relation "oauth_clients" does not
 * exist` buried in the container log.
 *
 * So the app checks at startup and says so, and reports it on /api/health where
 * a deploy or a healthcheck can gate on it. It does not migrate anything, and it
 * does not refuse to boot: which pending migration matters depends on which code
 * paths are in use, and that judgement belongs to whoever is deploying.
 *
 * The expected set is a list in code rather than a read of the migrations
 * directory. Kysely's FileMigrationProvider imports every file in that folder at
 * runtime, which does not survive bundling — the files are not in the server
 * build, and `@/` aliases in them do not resolve outside it. A list cannot drift
 * unnoticed either: status.test.ts compares it against the directory.
 */

import { sql } from 'kysely';
import { getDatabase } from '../client';

/**
 * Every migration this build expects, in order.
 *
 * Add a migration, add it here. The test guards the pairing, so forgetting
 * fails the suite rather than silently reporting a schema as up to date.
 */
export const EXPECTED_MIGRATIONS = [
  '001-init',
  '002-tenant-domains-and-grants',
  '003-sessions-and-audit',
  '004-add-role-map',
  '005-update-oidc-role-mapping',
  '006-bored-logs-schema',
  '007-oauth-clients',
  '008-token-refresh-locks',
  '009-sessions-and-token-identity',
  '010-provider-grants',
  '011-hash-refresh-tokens',
  '012-hash-client-secrets',
  '013-events',
  '014-provider-refresh-locks',
  '015-actionable-items',
];

export interface MigrationStatus {
  /** Expected by this build, absent from this database. */
  pending: string[];
  applied: number;
  /** Set when the check itself could not run — unknown, not up to date. */
  error?: string;
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return { pending: [], applied: 0, error: 'Database unavailable' };
  }

  try {
    // Kysely's own ledger. A fresh database has no such table, which means
    // nothing has been applied rather than that the check failed.
    const rows = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(
      dbResult.val
    );
    const applied = new Set(rows.rows.map((row) => row.name));

    return {
      pending: EXPECTED_MIGRATIONS.filter((name) => !applied.has(name)),
      applied: applied.size,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // 42P01: the ledger table does not exist. Nothing has ever been migrated.
    if (message.includes('kysely_migration')) {
      return { pending: [...EXPECTED_MIGRATIONS], applied: 0 };
    }

    return { pending: [], applied: 0, error: message };
  }
}

/** The one-line instruction an operator needs, kept next to the check. */
export const MIGRATION_COMMAND = 'docker compose -f docker-compose.yaml run --rm migrate';
