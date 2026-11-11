import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPEND_ONLY_TABLES,
  SANDBOX_TABLE_GRANTS,
  buildRoleStatements,
  quoteIdent,
  readRoleSpecs,
  scramVerifier,
} from './roles';

const context = { database: 'renkei', owner: 'renkei', exists: false };

describe('readRoleSpecs', () => {
  it('asks for nothing when neither role is configured', () => {
    expect(readRoleSpecs({})).toEqual({ ok: true, val: [] });
    expect(readRoleSpecs({ RENKEI_RUNTIME_DB_USER: '', RENKEI_RUNTIME_DB_PASSWORD: '' })).toEqual({
      ok: true,
      val: [],
    });
  });

  it('reads the runtime and sandbox roles', () => {
    const result = readRoleSpecs({
      RENKEI_RUNTIME_DB_USER: 'renkei_app',
      RENKEI_RUNTIME_DB_PASSWORD: 'a',
      RENKEI_SANDBOX_DB_USER: 'renkei_sandbox',
      RENKEI_SANDBOX_DB_PASSWORD: 'b',
    });
    expect(result.val).toEqual([
      { kind: 'runtime', name: 'renkei_app', password: 'a' },
      { kind: 'sandbox', name: 'renkei_sandbox', password: 'b' },
    ]);
  });

  it.each([
    [{ RENKEI_RUNTIME_DB_USER: 'renkei_app' }],
    [{ RENKEI_RUNTIME_DB_PASSWORD: 'secret' }],
    [{ RENKEI_RUNTIME_DB_USER: 'Bad-Name', RENKEI_RUNTIME_DB_PASSWORD: 'x' }],
    [{ RENKEI_RUNTIME_DB_USER: 'a"; DROP', RENKEI_RUNTIME_DB_PASSWORD: 'x' }],
    [{ RENKEI_RUNTIME_DB_USER: 'pg_monitor', RENKEI_RUNTIME_DB_PASSWORD: 'x' }],
    [
      {
        RENKEI_RUNTIME_DB_USER: 'same',
        RENKEI_RUNTIME_DB_PASSWORD: 'x',
        RENKEI_SANDBOX_DB_USER: 'same',
        RENKEI_SANDBOX_DB_PASSWORD: 'y',
      },
    ],
  ])('refuses %j', (env) => {
    const result = readRoleSpecs(env);
    expect(result.ok).toBe(false);
  });
});

describe('scramVerifier', () => {
  it('matches the RFC 7677 test vector', () => {
    // Salt and iteration count from the RFC's SCRAM-SHA-256 example.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const verifier = scramVerifier('pencil', salt, 4096);
    expect(verifier).toBe(
      'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$' +
        'WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:' +
        'wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU='
    );
  });

  it('never carries the plaintext and salts every call', () => {
    const a = scramVerifier('hunter2');
    expect(a).not.toContain('hunter2');
    expect(a).not.toBe(scramVerifier('hunter2'));
  });
});

describe('buildRoleStatements', () => {
  const runtime = { kind: 'runtime' as const, name: 'renkei_app', password: 'p@ss' };
  const sandbox = { kind: 'sandbox' as const, name: 'renkei_sandbox', password: 'p@ss' };

  it('creates a new role and alters an existing one, never with the plaintext password', () => {
    const created = buildRoleStatements(runtime, context)[1];
    expect(created).toMatch(/^CREATE ROLE "renkei_app" WITH LOGIN NOSUPERUSER/);
    expect(created).toContain("PASSWORD 'SCRAM-SHA-256$");
    expect(created).not.toContain('p@ss');
    const altered = buildRoleStatements(runtime, { ...context, exists: true })[1];
    expect(altered).toMatch(/^ALTER ROLE "renkei_app" WITH LOGIN/);
  });

  it('gives the runtime role DML everywhere and insert+select only on the trails', () => {
    const statements = buildRoleStatements(runtime, context);
    expect(statements).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "renkei_app"'
    );
    expect(statements).toContain(
      `REVOKE UPDATE, DELETE ON "audit_events", "delegate_access_events", "phi_access_events", "platform_audit_log" FROM "renkei_app"`
    );
    expect(statements).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON "kysely_migration" FROM "renkei_app"'
    );
    const blanket = statements.findIndex((s) =>
      s.startsWith('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL')
    );
    const narrowed = statements.findIndex((s) => s.startsWith('REVOKE UPDATE, DELETE ON'));
    expect(narrowed).toBeGreaterThan(blanket);
  });

  it('sets default privileges for tables the owner creates later', () => {
    const statements = buildRoleStatements(runtime, { ...context, owner: 'pg_owner' });
    expect(statements).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "pg_owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "renkei_app"'
    );
  });

  it('gives the sandbox role only its own tables and no default privileges', () => {
    const statements = buildRoleStatements(sandbox, context);
    const text = statements.join('\n');
    expect(statements).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "renkei_sandbox"');
    for (const table of SANDBOX_TABLE_GRANTS.all) expect(text).toContain(`"${table}"`);
    expect(text).not.toContain('ALTER DEFAULT PRIVILEGES');
    expect(text).not.toContain('ON ALL TABLES IN SCHEMA public TO');
    for (const table of [
      'chats',
      'agents',
      'user_encryption_keys',
      'provider_grants',
      'audit_events',
    ]) {
      expect(text).not.toContain(`"${table}"`);
    }
    // The grants come after the reset, never before.
    const reset = statements.findIndex((s) => s.startsWith('REVOKE ALL ON ALL TABLES'));
    const grant = statements.findIndex((s) =>
      s.startsWith('GRANT SELECT, INSERT, UPDATE, DELETE ON "')
    );
    expect(grant).toBeGreaterThan(reset);
  });

  it('quotes identifiers', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe('the append-only list', () => {
  it('names every table a migration guards with an update/delete trigger', () => {
    const dir = join(__dirname, 'migrations');
    const guarded = new Set<string>();
    for (const file of readdirSync(dir).filter((name) => /^\d.*\.ts$/.test(name))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const match of source.matchAll(
        /CREATE TRIGGER\s+\w+\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+(\w+)/gi
      )) {
        if (match[1]) guarded.add(match[1]);
      }
    }
    expect(guarded.size).toBeGreaterThanOrEqual(3);
    for (const table of guarded) expect(APPEND_ONLY_TABLES).toContain(table);
  });
});
