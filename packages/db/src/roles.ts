/**
 * Least-privilege database roles, ensured by the migrate step.
 *
 * One role owning everything and serving every process cannot keep an
 * append-only trail append-only: a table's owner may disable or drop the
 * trigger that guards it. So the migrate step, running as the owner, can
 * also create and keep up to date two LOGIN roles that own nothing:
 *
 *  - the RUNTIME role (RENKEI_RUNTIME_DB_USER / _PASSWORD), which every
 *    service but `migrate` connects as: SELECT/INSERT/UPDATE/DELETE on
 *    every table, USAGE on every sequence, INSERT and SELECT only on the
 *    audit trails, SELECT only on the migration ledger, and the same
 *    rights on every table a future migration creates (default
 *    privileges);
 *  - the SANDBOX role (RENKEI_SANDBOX_DB_USER / _PASSWORD), for the one
 *    container that runs other people's commands: the handful of tables
 *    the sandbox worker touches, and nothing else.
 *
 * Both are optional. With neither variable set nothing here runs and the
 * deployment keeps its single role, exactly as before. Every grant is
 * re-asserted on each run, in one transaction, so adding a table or
 * changing a list below takes effect with the next `migrate`.
 *
 * Everything here is SQL text built from validated names; the statements
 * need a real server and a role allowed to create roles, so they are
 * exercised by hand against Postgres (see DEPLOYMENT.md), and the builders
 * by roles.test.ts.
 */

import { createHmac, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getDatabase } from './client';
import type { DB } from './db.types';

/**
 * Tables the runtime role may only INSERT into and SELECT from. Every
 * table a migration guards with a BEFORE UPDATE OR DELETE trigger belongs
 * here (roles.test.ts holds the two lists together). Nothing in the
 * application updates or deletes these rows, retention included.
 */
export const APPEND_ONLY_TABLES = [
  'audit_events',
  'delegate_access_events',
  'phi_access_events',
  'platform_audit_log',
] as const;

/** The migration ledger: readable (the status check), never writable by a service. */
const LEDGER_READ_TABLE = 'kysely_migration';
const LEDGER_LOCK_TABLE = 'kysely_migration_lock';

/**
 * What the sandbox worker's own role may do, by table. Derived from the
 * stores `apps/worker-sandbox` calls (`sandboxFiles`, `sandboxWorkspaces`,
 * `sandboxServices`, `sandboxSecrets`, `sandboxEnvSecrets`,
 * `sandboxCrawls`, `codeServiceImageRules`), the organization settings it
 * polls (`settings`, `sandbox_size_requests` for a workspace's size
 * limit) and the log tables it writes. A table the worker starts to use
 * must be added here, or it fails on its first query.
 */
export const SANDBOX_TABLE_GRANTS = {
  all: [
    'code_service_image_rules',
    'sandbox_crawl_pages',
    'sandbox_crawl_recipes',
    'sandbox_crawls',
    'sandbox_env_secrets',
    'sandbox_files',
    'sandbox_secrets',
    'sandbox_services',
    'sandbox_workspaces',
  ],
  select: ['sandbox_size_requests', 'settings'],
  insertSelect: ['log_attr', 'log_attr_blob', 'logs'],
} as const;

export type RoleKind = 'runtime' | 'sandbox';

export interface RoleSpec {
  kind: RoleKind;
  name: string;
  password: string;
}

export interface RoleContext {
  /** The database the role may connect to. */
  database: string;
  /** The role running these statements, which owns the tables. */
  owner: string;
  /** Whether the role already exists (then it is altered, not created). */
  exists: boolean;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The salted SCRAM-SHA-256 verifier Postgres stores, so the plaintext never appears in a statement or the server log. */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = 4096
): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** A SQL string literal (standard_conforming_strings is set on for the transaction). */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The role specs the environment asks for. A user without a password (or a
 * password without a user) is an error rather than a silent skip, so a
 * half-set configuration never leaves a service on the owner role unseen.
 */
export function readRoleSpecs(
  env: Record<string, string | undefined>
): Result<RoleSpec[], 'ROLE_CONFIG_ERROR'> {
  const specs: RoleSpec[] = [];
  const kinds: [RoleKind, string, string][] = [
    ['runtime', 'RENKEI_RUNTIME_DB_USER', 'RENKEI_RUNTIME_DB_PASSWORD'],
    ['sandbox', 'RENKEI_SANDBOX_DB_USER', 'RENKEI_SANDBOX_DB_PASSWORD'],
  ];
  for (const [kind, userVar, passwordVar] of kinds) {
    const name = env[userVar]?.trim() ?? '';
    const password = env[passwordVar] ?? '';
    if (name === '' && password === '') continue;
    if (name === '' || password === '') {
      return err('ROLE_CONFIG_ERROR' as const, {
        message: `${userVar} and ${passwordVar} must be set together`,
      });
    }
    if (!ROLE_NAME.test(name)) {
      return err('ROLE_CONFIG_ERROR' as const, {
        message: `${userVar} must be lowercase letters, digits and underscores, starting with a letter or underscore`,
      });
    }
    if (name.startsWith('pg_')) {
      return err('ROLE_CONFIG_ERROR' as const, { message: `${userVar} may not start with pg_` });
    }
    if (password.includes('\0')) {
      return err('ROLE_CONFIG_ERROR' as const, { message: `${passwordVar} contains a NUL byte` });
    }
    specs.push({ kind, name, password });
  }
  if (specs.length === 2 && specs[0]?.name === specs[1]?.name) {
    return err('ROLE_CONFIG_ERROR' as const, {
      message: 'the runtime and sandbox roles must be different roles',
    });
  }
  return ok(specs);
}

const list = (names: readonly string[]): string => names.map(quoteIdent).join(', ');

/** The role itself: created with its password, or its password and attributes re-asserted. */
function roleStatement(spec: RoleSpec, exists: boolean): string {
  const attributes = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION';
  const verb = exists ? 'ALTER' : 'CREATE';
  return `${verb} ROLE ${quoteIdent(spec.name)} WITH ${attributes} PASSWORD ${quoteLiteral(scramVerifier(spec.password))}`;
}

/** Grant USAGE and SELECT on the sequences that belong to these tables' columns only. */
function sequenceGrantStatement(tables: readonly string[], role: string): string {
  const tableArray = `ARRAY[${tables.map(quoteLiteral).join(', ')}]`;
  return `DO $renkei$
DECLARE seq text;
BEGIN
  FOR seq IN
    SELECT format('%I.%I', n.nspname, s.relname)
    FROM pg_class s
    JOIN pg_namespace n ON n.oid = s.relnamespace
    JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid
    WHERE s.relkind = 'S' AND n.nspname = 'public' AND t.relname = ANY (${tableArray})
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO %I', seq, ${quoteLiteral(role)});
  END LOOP;
END
$renkei$`;
}

/** Every statement that brings one role to its intended privileges, in order. */
export function buildRoleStatements(spec: RoleSpec, context: RoleContext): string[] {
  const role = quoteIdent(spec.name);
  const common = [
    'SET LOCAL standard_conforming_strings = on',
    roleStatement(spec, context.exists),
    `GRANT CONNECT ON DATABASE ${quoteIdent(context.database)} TO ${role}`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
  ];

  if (spec.kind === 'runtime') {
    const owner = quoteIdent(context.owner);
    return [
      ...common,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      // The trails and the ledger are narrowed after the blanket grant, in
      // the same transaction, so there is never a moment they are writable.
      `REVOKE UPDATE, DELETE ON ${list(APPEND_ONLY_TABLES)} FROM ${role}`,
      `REVOKE INSERT, UPDATE, DELETE ON ${quoteIdent(LEDGER_READ_TABLE)} FROM ${role}`,
      `REVOKE ALL ON ${quoteIdent(LEDGER_LOCK_TABLE)} FROM ${role}`,
      // Tables a later migration creates (as the owner) arrive with the
      // same blanket rights; a new append-only table joins
      // APPEND_ONLY_TABLES in the same change, and the next migrate narrows it.
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
    ];
  }

  const { all, select, insertSelect } = SANDBOX_TABLE_GRANTS;
  return [
    ...common,
    // Start from nothing so a table dropped from the lists loses its grant.
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${list(all)} TO ${role}`,
    `GRANT SELECT ON ${list(select)} TO ${role}`,
    `GRANT SELECT, INSERT ON ${list(insertSelect)} TO ${role}`,
    sequenceGrantStatement([...all, ...insertSelect], spec.name),
  ];
}

/** Ensure the roles the environment names, as the connected (owner) role. Nothing to do when it names none. */
export async function ensureRuntimeRoles(
  env: Record<string, string | undefined> = process.env
): Promise<Result<RoleSpec['name'][], 'ROLE_CONFIG_ERROR' | 'DB_INIT_ERROR' | 'ROLE_ERROR'>> {
  const specs = readRoleSpecs(env);
  if (!specs.ok) return specs;
  if (specs.val.length === 0) return ok([]);

  const database = getDatabase();
  if (!database.ok) return database;
  const db: Kysely<DB> = database.val;

  try {
    const { rows } = await sql<{ owner: string; database: string }>`
      SELECT current_user AS owner, current_database() AS database
    `.execute(db);
    const [identity] = rows;
    if (!identity) return err('ROLE_ERROR' as const, { message: 'no current role' });
    for (const spec of specs.val) {
      if (spec.name === identity.owner) {
        return err('ROLE_CONFIG_ERROR' as const, {
          message: `${spec.name} is the role running migrations; the ${spec.kind} role must be a different role`,
        });
      }
    }
    await db.transaction().execute(async (trx) => {
      for (const spec of specs.val) {
        const existing = await sql<{ one: number }>`
          SELECT 1 AS one FROM pg_roles WHERE rolname = ${spec.name}
        `.execute(trx);
        const statements = buildRoleStatements(spec, {
          database: identity.database,
          owner: identity.owner,
          exists: existing.rows.length > 0,
        });
        for (const statement of statements) await sql.raw(statement).execute(trx);
      }
    });
    return ok(specs.val.map((spec) => spec.name));
  } catch (error) {
    return err('ROLE_ERROR' as const, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
