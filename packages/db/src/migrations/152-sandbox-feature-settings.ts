import { Kysely, sql } from 'kysely';

/**
 * The sandbox worker's feature switches move from the environment into
 * each organization's settings (packages/settings: sandboxBrowserEnabled,
 * sandboxChartsEnabled, sandboxWorkspacesEnabled, sandboxServicesEnabled,
 * sandboxScriptsEnabled, sandboxScriptsAllowNetwork), where an admin
 * flips them on the Settings page instead of an operator editing `.env`
 * on two containers and restarting both.
 *
 * No table changes: the settings live in `tenant_settings`. What this
 * migration does is carry a deployment's existing choice across: for each
 * SANDBOX_*_ENABLED variable (and SANDBOX_SCRIPTS_ALLOW_NETWORK) that is
 * SET in the environment this migration runs with, every organization
 * that exists now gets that value as its explicit setting. A variable
 * that is unset writes nothing, so the organization stays on the default
 * (off). Run the migration with the same `.env` the web app had and
 * nothing changes for anyone; afterwards the variables are unread.
 */
const FLAGS: Array<[key: string, variable: string]> = [
  ['sandbox_browser_enabled', 'SANDBOX_BROWSER_ENABLED'],
  ['sandbox_charts_enabled', 'SANDBOX_CHARTS_ENABLED'],
  ['sandbox_workspaces_enabled', 'SANDBOX_WORKSPACES_ENABLED'],
  ['sandbox_services_enabled', 'SANDBOX_SERVICES_ENABLED'],
  ['sandbox_scripts_enabled', 'SANDBOX_SCRIPTS_ENABLED'],
  ['sandbox_scripts_allow_network', 'SANDBOX_SCRIPTS_ALLOW_NETWORK'],
];

function flagValue(variable: string): boolean | null {
  const raw = process.env[variable];
  if (raw === undefined || raw.trim() === '') return null;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [key, variable] of FLAGS) {
    const value = flagValue(variable);
    if (value === null) continue;
    await sql`
      INSERT INTO tenant_settings (tenant_id, key, value)
      SELECT id, ${key}, ${JSON.stringify(value)}::jsonb FROM tenants
      ON CONFLICT (tenant_id, key) DO NOTHING
    `.execute(db);
  }
}

export async function down(): Promise<void> {
  // The rows record what each organization had; they do no harm left in
  // place, and an older build simply never reads them.
}
