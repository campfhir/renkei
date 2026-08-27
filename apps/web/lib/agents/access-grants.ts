/**
 * Named-person access to someone else's agent (migration 064) — the data
 * layer for troubleshooting shares, and the ONE resolver every agent
 * surface asks "may this viewer see this agent, and as whom?".
 *
 * The rules, in one place:
 *   - The owner always resolves, grant or not.
 *   - A non-owner resolves only through an unexpired grant row, and then
 *     sees the agent exactly as the owner does (run details unredacted,
 *     edit allowed) — that is the point of the feature.
 *   - Grant management (create / list / revoke) is owner-only,
 *     enforced structurally: every mutation is keyed by the owner's
 *     subject, so someone else's grant row resolves to "not found".
 *
 * Expired rows keep granting NOTHING but stay listed in the owner's
 * sharing modal, marked lapsed, until the owner deletes them — an expiry
 * that silently vanished would read as "I never shared this".
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { getAgent, getAgentWithOwner, type StoredAgent } from './store';

export interface AgentAccess {
  agent: StoredAgent;
  ownerSubject: string;
  viewerIsOwner: boolean;
  /** The unexpired grant that admitted a non-owner; null for the owner. */
  grant: { id: string; expiresAt: string | null } | null;
}

/** One row of the owner's "who has access" list. */
export interface AgentAccessGrantView {
  id: string;
  granteeSubject: string;
  granteeName: string | null;
  granteeEmail: string | null;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
}

/** An agent someone else shared with the viewer, for the agents screen. */
export interface SharedAgentListing {
  agent: StoredAgent;
  ownerSubject: string;
  ownerName: string | null;
  ownerEmail: string | null;
  expiresAt: string | null;
}

const grantIso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/**
 * Who is this viewer to this agent? Owner, grantee, or nobody (null —
 * which callers surface as 404, never 403, matching the structural-
 * ownership rule everywhere else).
 */
export async function resolveAgentAccess(
  db: Kysely<DB>,
  tenantId: string,
  viewerSubject: string,
  agentId: string
): Promise<AgentAccess | null> {
  const owned = await getAgent(db, tenantId, viewerSubject, agentId);
  if (owned) {
    return { agent: owned, ownerSubject: viewerSubject, viewerIsOwner: true, grant: null };
  }
  if (!isUuid(agentId)) return null;
  const grant = await db
    .selectFrom('agent_access_grants')
    .select(['id', 'owner_subject', 'expires_at'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('grantee_subject', '=', viewerSubject)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`NOW()`)]))
    .executeTakeFirst();
  if (!grant) return null;
  const found = await getAgentWithOwner(db, tenantId, agentId);
  if (!found) return null;
  return {
    agent: found.agent,
    ownerSubject: found.ownerSubject,
    viewerIsOwner: false,
    grant: { id: grant.id, expiresAt: grantIso(grant.expires_at) },
  };
}

/**
 * The bare "does an unexpired grant admit this viewer" check, for routes
 * that already hold the agent row and only need the yes/no (the invoke and
 * rerun paths). Everything else wants resolveAgentAccess.
 */
export async function hasActiveGrant(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  viewerSubject: string
): Promise<boolean> {
  if (!isUuid(agentId)) return false;
  const row = await db
    .selectFrom('agent_access_grants')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('grantee_subject', '=', viewerSubject)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`NOW()`)]))
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Owner grants (or re-grants — the row is upserted, so sharing again just
 * refreshes the expiry) access to one person.
 */
export async function grantAgentAccess(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string,
  input: { granteeSubject: string; expiresAt: Date | null }
): Promise<'OK' | 'NOT_FOUND' | 'SELF'> {
  if (input.granteeSubject === ownerSubject) return 'SELF';
  const owned = await getAgent(db, tenantId, ownerSubject, agentId);
  if (!owned) return 'NOT_FOUND';
  await db
    .insertInto('agent_access_grants')
    .values({
      id: randomUUID(),
      tenant_id: tenantId,
      agent_id: agentId,
      owner_subject: ownerSubject,
      grantee_subject: input.granteeSubject,
      expires_at: input.expiresAt,
    })
    .onConflict((oc) =>
      oc.columns(['agent_id', 'grantee_subject']).doUpdateSet({ expires_at: input.expiresAt })
    )
    .execute();
  return 'OK';
}

/** The owner's list for the sharing modal, expired rows included. */
export async function listAgentAccessGrants(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string
): Promise<AgentAccessGrantView[] | null> {
  const owned = await getAgent(db, tenantId, ownerSubject, agentId);
  if (!owned) return null;
  const rows = await db
    .selectFrom('agent_access_grants')
    .leftJoin('identities', (join) =>
      join
        .onRef('identities.subject', '=', 'agent_access_grants.grantee_subject')
        .onRef('identities.tenant_id', '=', 'agent_access_grants.tenant_id')
    )
    .select([
      'agent_access_grants.id as id',
      'agent_access_grants.grantee_subject as grantee_subject',
      'agent_access_grants.expires_at as expires_at',
      'agent_access_grants.created_at as created_at',
      'identities.display_name as display_name',
      'identities.email as email',
    ])
    .where('agent_access_grants.tenant_id', '=', tenantId)
    .where('agent_access_grants.agent_id', '=', agentId)
    .orderBy('agent_access_grants.created_at', 'asc')
    .execute();
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    granteeSubject: row.grantee_subject,
    granteeName: row.display_name,
    granteeEmail: row.email,
    expiresAt: grantIso(row.expires_at),
    expired: row.expires_at !== null && row.expires_at.getTime() <= now,
    createdAt: row.created_at.toISOString(),
  }));
}

/** Owner deletes a grant row — revocation. Returns the row for the audit label. */
export async function revokeAgentAccessGrant(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string,
  grantId: string
): Promise<{ granteeSubject: string } | null> {
  if (!isUuid(grantId) || !isUuid(agentId)) return null;
  const row = await db
    .deleteFrom('agent_access_grants')
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', grantId)
    .returning(['grantee_subject'])
    .executeTakeFirst();
  return row ? { granteeSubject: row.grantee_subject } : null;
}

/**
 * The agents other people shared with this viewer — the "Shared with you"
 * group on the agents screen. Only unexpired grants appear; a lapsed share
 * simply drops out of the viewer's list.
 */
export async function listAgentsSharedWith(
  db: Kysely<DB>,
  tenantId: string,
  granteeSubject: string
): Promise<SharedAgentListing[]> {
  const rows = await db
    .selectFrom('agent_access_grants')
    .leftJoin('identities', (join) =>
      join
        .onRef('identities.subject', '=', 'agent_access_grants.owner_subject')
        .onRef('identities.tenant_id', '=', 'agent_access_grants.tenant_id')
    )
    .select([
      'agent_access_grants.agent_id as agent_id',
      'agent_access_grants.owner_subject as owner_subject',
      'agent_access_grants.expires_at as expires_at',
      'identities.display_name as owner_name',
      'identities.email as owner_email',
    ])
    .where('agent_access_grants.tenant_id', '=', tenantId)
    .where('agent_access_grants.grantee_subject', '=', granteeSubject)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`NOW()`)]))
    .orderBy('agent_access_grants.created_at', 'desc')
    .execute();
  const listings: SharedAgentListing[] = [];
  for (const row of rows) {
    const found = await getAgentWithOwner(db, tenantId, row.agent_id);
    if (!found) continue;
    listings.push({
      agent: found.agent,
      ownerSubject: row.owner_subject,
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      expiresAt: grantIso(row.expires_at),
    });
  }
  return listings;
}
