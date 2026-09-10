/**
 * Which connectors a person is in the audience of.
 *
 * An admin scopes a connector to people carrying certain IdP group values
 * (`OrgSettings.connectorAudiences`, capability key → values). Everyone
 * else must neither see its card nor have its tools registered. This
 * module answers per subject, from the database — the groups recorded at
 * their last sign-in — never from token roles, because agent-run tokens
 * carry none and a stale token must not widen anything.
 *
 * Fails CLOSED. An unreadable settings row or identity means "outside every
 * audience", never "inside": a restriction that silently lapses when a query
 * fails is worse than no restriction, because nobody is watching for it.
 * Note this is the opposite default from readConnectorConfigCached, whose
 * failure degrades to the connector being unavailable — both land on "less
 * access", which is the point.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { idpGroupsFor } from '@/lib/identity';

/** What the capability projection needs: the org's rule keys, and this caller's share of them. */
export interface AudienceResolution {
  restrictedConnectors: string[];
  allowedConnectors: string[];
}

/** The audience gate's verdict per capability key, for the connectors page. */
export type AudienceAllows = (capabilityKey: string) => boolean;

/** The rule keys that actually restrict — an empty list is "everyone", not a rule. */
export function restrictedKeys(audiences: Record<string, readonly string[]>): string[] {
  return Object.entries(audiences)
    .filter(([, values]) => values.length > 0)
    .map(([key]) => key);
}

/** Pure: the restricted keys whose values intersect the person's groups. */
export function allowedKeys(
  audiences: Record<string, readonly string[]>,
  groups: readonly string[]
): string[] {
  const held = new Set(groups);
  return restrictedKeys(audiences).filter((key) => audiences[key].some((value) => held.has(value)));
}

/** Everything closed: the shape returned when the rules or the identity could not be read. */
function closed(restricted?: string[]): AudienceResolution {
  return {
    restrictedConnectors: restricted ?? CONNECTOR_CATALOG.map((entry) => entry.capabilityKey),
    allowedConnectors: [],
  };
}

export async function resolveAudience(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<AudienceResolution> {
  const settings = await getOrgSettings(tenantId);
  if (!settings.ok) return closed();
  const audiences = settings.val.connectorAudiences ?? {};
  const restricted = restrictedKeys(audiences);
  if (restricted.length === 0) return { restrictedConnectors: [], allowedConnectors: [] };

  const groups = await idpGroupsFor(db, tenantId, subject);
  if (!groups.ok) return closed(restricted);
  return {
    restrictedConnectors: restricted,
    allowedConnectors: allowedKeys(audiences, groups.val),
  };
}

/** The same answer as a predicate, for the connectors page's catalog. */
export async function resolveAudienceAllows(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<AudienceAllows> {
  const resolution = await resolveAudience(db, tenantId, subject);
  const restricted = new Set(resolution.restrictedConnectors);
  const allowed = new Set(resolution.allowedConnectors);
  return (capabilityKey) => !restricted.has(capabilityKey) || allowed.has(capabilityKey);
}
