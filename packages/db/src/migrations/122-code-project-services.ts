import { Kysely, sql } from 'kysely';

/**
 * Code project services (docs/sandbox-workspaces-design.md, "Services"):
 * a container — Postgres, Redis, a broker — the sandbox worker starts
 * beside a project's checkout so the project's tests have the thing they
 * need, from an image the organization allows.
 *
 * `code_service_image_rules` is the organization's allow-list, one row
 * per rule in the normalized `host[/path]` spelling
 * (@renkei/connector-sandbox's normalizeImageRule): a whole registry
 * (`myorg.azurecr.io`), a namespace on one (`myorg.azurecr.io/platform/*`)
 * or a single repository (`docker.io/library/postgres`, any tag). A rule
 * may carry the credential a pull from its host presents —
 * `registry_username` in the clear, `registry_sealed` an envelope sealed
 * and opened ONLY by apps/worker-sandbox (the env-secrets arrangement:
 * under SANDBOX_ENV_SECRETS_KEY, falling back to the deployment key), so
 * a service principal's secret passes through the web app once, on the
 * way in, and is never read back by anything but the worker at pull
 * time. Every tenant is seeded with the public images below; an
 * operator adds their own registry, or removes what they do not want —
 * the seed-then-let-them-own-it idiom of 115-code-project-templates.
 *
 * `sandbox_services` is one row per service a project holds — the
 * metadata half of a container the worker created on its Docker engine
 * under `container_id`, scoped by (tenant_id, subject) exactly as the
 * project's checkout and environment are. `ports` are the ports the
 * image declares; `exports` the variables (name → template over {host}
 * and {port}) the service adds to the project's commands while it runs.
 * Rows carry an `expires_at` the worker's sweep enforces, extended on
 * use, the same lifetime discipline as sandbox_workspaces: a service is
 * working state, not a source of truth.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('code_service_image_rules')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('pattern', 'varchar(512)', (col) => col.notNull())
    .addColumn('note', 'varchar(300)')
    .addColumn('registry_username', 'varchar(255)')
    .addColumn('registry_sealed', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // One rule per pattern: two rows for the same registry would only
  // disagree about the credential.
  await db.schema
    .createIndex('idx_code_service_image_rules_tenant_pattern')
    .unique()
    .on('code_service_image_rules')
    .columns(['tenant_id', 'pattern'])
    .execute();

  const seed: Array<[string, string]> = [
    ['docker.io/library/postgres', 'PostgreSQL (official image)'],
    ['docker.io/pgvector/pgvector', 'PostgreSQL with the vector extension'],
    ['docker.io/library/redis', 'Redis (official image)'],
    ['docker.io/valkey/valkey', 'Valkey, the Redis fork'],
    ['docker.io/library/mysql', 'MySQL (official image)'],
    ['docker.io/library/mariadb', 'MariaDB (official image)'],
    ['docker.io/library/mongo', 'MongoDB (official image)'],
    ['docker.io/library/rabbitmq', 'RabbitMQ (official image)'],
    ['mcr.microsoft.com/mssql/server', 'SQL Server on Linux'],
    ['mcr.microsoft.com/azure-storage/azurite', 'Azurite, the Azure Storage emulator'],
  ];
  for (const [pattern, note] of seed) {
    // Cross-joined against every tenant, guarded so it is idempotent and
    // never touches a row an operator already has for the same pattern.
    await sql`
      INSERT INTO code_service_image_rules (id, tenant_id, pattern, note)
      SELECT gen_random_uuid(), t.id, ${pattern}, ${note}
      FROM tenants t
      WHERE NOT EXISTS (
        SELECT 1 FROM code_service_image_rules existing
         WHERE existing.tenant_id = t.id AND existing.pattern = ${pattern}
      )
    `.execute(db);
  }

  await db.schema
    .createTable('sandbox_services')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('name', 'varchar(32)', (col) => col.notNull())
    .addColumn('image', 'varchar(600)', (col) => col.notNull())
    .addColumn('container_id', 'varchar(128)')
    .addColumn('status', 'varchar(16)', (col) => col.notNull().defaultTo('starting'))
    .addColumn('error', 'text')
    .addColumn('host', 'varchar(64)')
    .addColumn('ports', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('exports', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('last_used_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .execute();

  // One name per project: `db` is how the project's commands find it.
  await db.schema
    .createIndex('idx_sandbox_services_owner_name')
    .unique()
    .on('sandbox_services')
    .columns(['tenant_id', 'subject', 'name'])
    .execute();

  // The sweep walks by expiry.
  await db.schema
    .createIndex('idx_sandbox_services_expiry')
    .on('sandbox_services')
    .column('expires_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sandbox_services').execute();
  await db.schema.dropTable('code_service_image_rules').execute();
}
