/**
 * What one person's connectors page shows, and what it may offer.
 *
 * Three sets, kept apart because they answer different questions:
 *
 *   available  what this person MAY add — org-enabled, not switched off,
 *              and (audience rules) meant for them. The catalog they search.
 *   connected  what they HAVE linked — a grant, or a share connection.
 *   shown      what the page renders: added ∪ connected. A connector
 *              somebody linked before the catalog existed, or linked without
 *              ever pressing "add", keeps its card; nobody loses a working
 *              connection to a layout preference.
 *
 * None of this touches tool registration. Whether a tool registers is
 * provisioning plus org policy (the capability projection), and a page
 * preference must never be able to widen or narrow that — "added" is where
 * a card sits, not what a model may call.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { getConnectorPrefs } from '@renkei/user-prefs';
import { listSharesWithConnection } from '@renkei/connector-fileshares';
import {
  CONNECTOR_CATALOG,
  userConnectableConnectors,
  type ConnectorEntry,
} from '@/lib/connector-catalog';

/** One person's grant on a provider, as the cards need it. */
export interface GrantSummary {
  provider: string;
  displayName: string | null;
  requestedScopes: string[] | null;
  grantedScopes: string[] | null;
  metadata: unknown;
}

export interface UserCatalog {
  /** Entries this person may add (already-added ones included). */
  available: ConnectorEntry[];
  /** Capability keys with a card on the page. */
  shown: Set<string>;
  /** Capability keys this person has linked. */
  connected: Set<string>;
  /** Capability keys this person chose to add, as stored. */
  added: string[];
  /** This person's grants by provider, for the cards' connection state. */
  grants: Map<string, GrantSummary>;
}

/**
 * The org-side filter, pure so it can be tested: which user-connectable
 * entries the org has provisioned and not switched off.
 *
 * `enabledConfigKeys` are connector_configs rows with enabled = true;
 * file shares have no such row and count as provisioned when any share
 * exists. `audienceAllows` is the audience gate's answer per capability key
 * (always true until audience rules exist for the connector).
 */
export function availableEntries(input: {
  enabledConfigKeys: ReadonlySet<string>;
  anyShares: boolean;
  disabledConnectors: readonly string[];
  audienceAllows?: (capabilityKey: string) => boolean;
}): ConnectorEntry[] {
  const disabled = new Set(input.disabledConnectors);
  const allows = input.audienceAllows ?? (() => true);
  return userConnectableConnectors().filter((entry) => {
    if (disabled.has(entry.capabilityKey)) return false;
    if (!allows(entry.capabilityKey)) return false;
    if (entry.capabilityKey === 'fileshares') return input.anyShares;
    return input.enabledConfigKeys.has(entry.configKey);
  });
}

/** Which capability keys a set of grant providers (and share connections) means are connected. */
export function connectedKeys(
  grantProviders: ReadonlySet<string>,
  anyShareConnected: boolean
): Set<string> {
  const keys = new Set<string>();
  for (const entry of CONNECTOR_CATALOG) {
    if (entry.grantProviders.some((provider) => grantProviders.has(provider))) {
      keys.add(entry.capabilityKey);
    }
  }
  if (anyShareConnected) keys.add('fileshares');
  return keys;
}

/**
 * The cards to render: what was added, plus what is connected — but never a
 * connector the org no longer offers this person. A restricted or switched
 * off connector's grant stays (the tools are already unregistered by the
 * projection); its card simply is not on the page until the rule changes.
 */
export function shownKeys(
  added: readonly string[],
  connected: ReadonlySet<string>,
  available: readonly ConnectorEntry[]
): Set<string> {
  const offered = new Set(available.map((entry) => entry.capabilityKey));
  const shown = new Set<string>();
  for (const key of [...added, ...connected]) {
    if (offered.has(key)) shown.add(key);
  }
  return shown;
}

/** Every grant this person holds in the tenant, one query. */
export async function grantsFor(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Map<string, GrantSummary>> {
  const rows = await db
    .selectFrom('provider_grants')
    .select(['provider', 'display_name', 'requested_scopes', 'granted_scopes', 'metadata'])
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .execute();
  const grants = new Map<string, GrantSummary>();
  for (const row of rows) {
    grants.set(row.provider, {
      provider: row.provider,
      displayName: row.display_name,
      requestedScopes: row.requested_scopes ?? null,
      grantedScopes: row.granted_scopes ?? null,
      metadata: row.metadata,
    });
  }
  return grants;
}

export async function resolveUserCatalog(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  options: {
    /** The audience gate's verdict per capability key; absent means everyone. */
    audienceAllows?: (capabilityKey: string) => boolean;
    /** Read the person's selections fresh — pass from any surface they can save from. */
    fresh?: boolean;
  } = {}
): Promise<UserCatalog> {
  const [configs, settings, shares, grants, prefs] = await Promise.all([
    db
      .selectFrom('connector_configs')
      .select('connector')
      .where('tenant_id', '=', tenantId)
      .where('enabled', '=', true)
      .execute(),
    getOrgSettings(tenantId),
    listSharesWithConnection(db, tenantId, subject),
    grantsFor(db, tenantId, subject),
    getConnectorPrefs(tenantId, subject, { fresh: options.fresh }),
  ]);

  const shareRows = shares.ok ? shares.val : [];
  const available = availableEntries({
    enabledConfigKeys: new Set(configs.map((row) => row.connector)),
    anyShares: shareRows.length > 0,
    // Unreadable settings read as nothing disabled: the projection, which
    // gates the tools, makes its own read and fails its own way.
    disabledConnectors: settings.ok ? settings.val.disabledConnectors : [],
    audienceAllows: options.audienceAllows,
  });
  const connected = connectedKeys(
    new Set(grants.keys()),
    shareRows.some((row) => row.connection !== null)
  );

  return {
    available,
    shown: shownKeys(prefs.added, connected, available),
    connected,
    added: prefs.added,
    grants,
  };
}
