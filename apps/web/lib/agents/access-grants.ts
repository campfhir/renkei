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
import { getDataStore } from '@renkei/db';
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
  viewerSubject: string,
  agentId: string
): Promise<AgentAccess | null> {
  const owned = await getAgent(viewerSubject, agentId);
  if (owned) {
    return { agent: owned, ownerSubject: viewerSubject, viewerIsOwner: true, grant: null };
  }
  if (!isUuid(agentId)) return null;
  const grant = await getDataStore().agents.findActiveGrant(agentId, viewerSubject);
  if (!grant) return null;
  const found = await getAgentWithOwner(agentId);
  if (!found) return null;
  return {
    agent: found.agent,
    ownerSubject: found.ownerSubject,
    viewerIsOwner: false,
    grant: { id: grant.id, expiresAt: grantIso(grant.expiresAt) },
  };
}

/**
 * The bare "does an unexpired grant admit this viewer" check, for routes
 * that already hold the agent row and only need the yes/no (the invoke and
 * rerun paths). Everything else wants resolveAgentAccess.
 */
export async function hasActiveGrant(agentId: string, viewerSubject: string): Promise<boolean> {
  if (!isUuid(agentId)) return false;
  return (await getDataStore().agents.findActiveGrant(agentId, viewerSubject)) !== null;
}

/**
 * Owner grants (or re-grants — the row is upserted, so sharing again just
 * refreshes the expiry) access to one person.
 */
export async function grantAgentAccess(
  ownerSubject: string,
  agentId: string,
  input: { granteeSubject: string; expiresAt: Date | null }
): Promise<'OK' | 'NOT_FOUND' | 'SELF'> {
  if (input.granteeSubject === ownerSubject) return 'SELF';
  const owned = await getAgent(ownerSubject, agentId);
  if (!owned) return 'NOT_FOUND';
  await getDataStore().agents.upsertGrant({
    id: randomUUID(),
    agentId,
    ownerSubject,
    granteeSubject: input.granteeSubject,
    expiresAt: input.expiresAt,
  });
  return 'OK';
}

/** The owner's list for the sharing modal, expired rows included. */
export async function listAgentAccessGrants(
  ownerSubject: string,
  agentId: string
): Promise<AgentAccessGrantView[] | null> {
  const owned = await getAgent(ownerSubject, agentId);
  if (!owned) return null;
  const rows = await getDataStore().agents.listGrants(agentId);
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    granteeSubject: row.granteeSubject,
    granteeName: row.granteeName,
    granteeEmail: row.granteeEmail,
    expiresAt: grantIso(row.expiresAt),
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Owner deletes a grant row — revocation. Returns the row for the audit label. */
export async function revokeAgentAccessGrant(
  ownerSubject: string,
  agentId: string,
  grantId: string
): Promise<{ granteeSubject: string } | null> {
  if (!isUuid(grantId) || !isUuid(agentId)) return null;
  return getDataStore().agents.revokeGrant(ownerSubject, agentId, grantId);
}

/** How many unexpired grants an agent has — the owner's badge. */
export async function countActiveAgentGrants(agentId: string): Promise<number> {
  if (!isUuid(agentId)) return 0;
  return getDataStore().agents.countActiveGrants(agentId);
}

/**
 * The agents other people shared with this viewer — the "Shared with you"
 * group on the agents screen. Only unexpired grants appear; a lapsed share
 * simply drops out of the viewer's list.
 */
export async function listAgentsSharedWith(granteeSubject: string): Promise<SharedAgentListing[]> {
  const rows = await getDataStore().agents.listSharedWith(granteeSubject);
  const listings: SharedAgentListing[] = [];
  for (const row of rows) {
    const found = await getAgentWithOwner(row.agentId);
    if (!found) continue;
    listings.push({
      agent: found.agent,
      ownerSubject: row.ownerSubject,
      ownerName: row.ownerName,
      ownerEmail: row.ownerEmail,
      expiresAt: grantIso(row.expiresAt),
    });
  }
  return listings;
}
