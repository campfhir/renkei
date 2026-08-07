import { Kysely } from 'kysely'
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Initialize bored-logs schema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/consistent-type-assertions
  const adapter = new PostgresAdapter({ db: db as any })
  await adapter.migrate()
  console.log('[Migration] bored-logs schema initialized')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rollback bored-logs schema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/consistent-type-assertions
  const adapter = new PostgresAdapter({ db: db as any })
  await adapter.rollback()
  console.log('[Migration] bored-logs schema rolled back')
}
