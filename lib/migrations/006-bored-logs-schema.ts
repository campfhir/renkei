import { Kysely } from 'kysely'
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql'

export async function up(db: Kysely<any>): Promise<void> {
  // Initialize bored-logs schema
  const adapter = new PostgresAdapter({ db: db as any })
  await adapter.migrate()
  console.log('[Migration] bored-logs schema initialized')
}

export async function down(db: Kysely<any>): Promise<void> {
  // Rollback bored-logs schema
  const adapter = new PostgresAdapter({ db: db as any })
  await adapter.rollback()
  console.log('[Migration] bored-logs schema rolled back')
}
