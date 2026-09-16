import { Kysely, sql } from 'kysely';

/**
 * Mirth connections: named permissions instead of a read / act /
 * destructive ladder.
 *
 * 106 stored a person's LLM-exposure choice as `tool_access` ('read' or
 * 'read_write') plus `allow_destructive`. Those words meant little to the
 * person choosing them, and one switch covered too much: "may deploy a
 * channel" should not have to mean "may edit its definition". The choice
 * is now a set of permission ids a person recognises — `channels.read`,
 * `channels.deploy`, `messages.delete`, `server.restore`… — one per tool
 * (see packages/connector-mirth/src/permissions.ts for the catalog).
 *
 * Existing rows are converted to the closest equivalent so nobody loses a
 * working connection: read-only keeps every read permission; read/write
 * keeps every non-permanent one; read/write with destructive keeps all.
 * The old columns are dropped; `down` rebuilds them from the set.
 */
const READS = [
  'channels.read',
  'messages.read',
  'alerts.read',
  'code_templates.read',
  'users.read',
  'events.read',
  'server.read',
];
const WRITES = [
  'channels.edit',
  'channels.deploy',
  'messages.send',
  'alerts.edit',
  'code_templates.edit',
  'users.edit',
  'server.configure',
];
const PERMANENT = [
  'channels.delete',
  'messages.delete',
  'alerts.delete',
  'code_templates.delete',
  'users.delete',
  'server.restore',
];

const array = (ids: string[]) => sql`ARRAY[${sql.join(ids.map((id) => sql.lit(id)))}]::text[]`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('mirth_instance_connections')
    .addColumn('permissions', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .execute();

  await sql`
    UPDATE mirth_instance_connections
    SET permissions = CASE
      WHEN tool_access = 'read' THEN ${array(READS)}
      WHEN allow_destructive THEN ${array([...READS, ...WRITES, ...PERMANENT])}
      ELSE ${array([...READS, ...WRITES])}
    END
  `.execute(db);

  await db.schema.alterTable('mirth_instance_connections').dropColumn('tool_access').execute();
  await db.schema
    .alterTable('mirth_instance_connections')
    .dropColumn('allow_destructive')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('mirth_instance_connections')
    .addColumn('tool_access', 'varchar(10)', (col) =>
      col
        .notNull()
        .defaultTo('read')
        .check(sql`tool_access IN ('read', 'read_write')`)
    )
    .execute();
  await db.schema
    .alterTable('mirth_instance_connections')
    .addColumn('allow_destructive', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();

  await sql`
    UPDATE mirth_instance_connections
    SET tool_access = CASE
          WHEN permissions && ${array([...WRITES, ...PERMANENT])} THEN 'read_write'
          ELSE 'read'
        END,
        allow_destructive = permissions && ${array(PERMANENT)}
  `.execute(db);

  await db.schema.alterTable('mirth_instance_connections').dropColumn('permissions').execute();
}
