import { sql, type Kysely } from 'kysely';

/**
 * The sandbox worker's optional capabilities become org settings.
 *
 * They used to be environment flags — SANDBOX_BROWSER_ENABLED,
 * SANDBOX_CHARTS_ENABLED, SANDBOX_WORKSPACES_ENABLED,
 * SANDBOX_SERVICES_ENABLED, SANDBOX_SCRIPTS_ENABLED — read by the web app
 * (to register the tools and show the Code section) and by the worker (to
 * build the capability). Whether an org may use a capability is policy,
 * and policy is data (RENKEI.md Decision #19): the switches now live in
 * `tenant_settings` (`sandbox_*_enabled`, off by default) and the worker
 * builds every capability it has the means for.
 *
 * This migration is the ONE place the old flags are still read, so an
 * upgrade keeps behaving the way the deployment's `.env` said: for each
 * flag that is on in the migrate process's environment (the compose
 * `migrate` service loads the same `.env` the app did), the matching
 * switch is written for every existing org — without overwriting a row an
 * admin has already set. A flag that is unset or off writes nothing: the
 * default is off, which is what the flag meant. After this runs, the
 * flags are inert everywhere; remove them from `.env`.
 */
const FLAGS: ReadonlyArray<readonly [env: string, key: string]> = [
  ['SANDBOX_BROWSER_ENABLED', 'sandbox_browser_enabled'],
  ['SANDBOX_CHARTS_ENABLED', 'sandbox_charts_enabled'],
  ['SANDBOX_WORKSPACES_ENABLED', 'sandbox_workspaces_enabled'],
  ['SANDBOX_SERVICES_ENABLED', 'sandbox_services_enabled'],
  ['SANDBOX_SCRIPTS_ENABLED', 'sandbox_scripts_enabled'],
];

function flagOn(name: string): boolean {
  return /^(1|true|yes|on)$/i.test((process.env[name] ?? '').trim());
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const keys = FLAGS.filter(([env]) => flagOn(env)).map(([, key]) => key);
  if (keys.length === 0) return;
  for (const key of keys) {
    await sql`
      INSERT INTO tenant_settings (tenant_id, key, value)
      SELECT id, ${key}, 'true'::jsonb FROM tenants
      ON CONFLICT (tenant_id, key) DO NOTHING
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The switches have no meaning to the code before this migration; the
  // environment flags, where still set, take over again.
  await sql`
    DELETE FROM tenant_settings
    WHERE key IN (${sql.join(FLAGS.map(([, key]) => key))})
  `.execute(db);
}
