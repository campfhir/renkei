/**
 * Who one person is, for the operator's per-person usage view: the
 * identity spine's name and email, when they last signed in, the groups
 * the IdP reported at that sign-in, and the agents they own. Their
 * connectors are not here — those are the Access page's table, where an
 * operator disconnects one.
 *
 * Someone can exist with no identity row at all — a grant or an agent can
 * outlive its owner's last sign-in — so the lookup unions the sources and
 * answers null only when none of them knows the subject.
 */

import { getDataStore } from '@renkei/db';

export interface PersonAgent {
  id: string;
  name: string;
  enabled: boolean;
  /** ISO timestamp of the newest run, or null when it has never run. */
  lastRunAt: string | null;
}

export interface PersonProfile {
  subject: string;
  name: string;
  email: string | null;
  /** ISO timestamp of the newest session touch, or null when they never signed in. */
  lastActiveAt: string | null;
  idpGroups: string[];
  agents: PersonAgent[];
}

/**
 * `agentsOf` lists the agents a subject owns — the agents area's own read
 * (lib/agents/runs-view.ts's listAgentsForOwner), handed in so this module
 * reads only what it owns.
 */
export async function getPersonProfile(
  subject: string,
  agentsOf: (subject: string) => Promise<PersonAgent[]>
): Promise<PersonProfile | null> {
  const store = getDataStore();
  const [identity, grant, agents, lastActive] = await Promise.all([
    store.identities.get(subject),
    // A grant's display name is the fallback name for someone who never
    // signed in — and proof they exist at all.
    store.orgAccess.firstGrantOf(subject),
    agentsOf(subject),
    store.sessions.lastUsedOf(subject),
  ]);

  if (!identity && !grant && agents.length === 0) return null;

  return {
    subject,
    name: identity?.displayName || identity?.email || grant?.displayName || subject,
    email: identity?.email ?? null,
    lastActiveAt: lastActive ? lastActive.toISOString() : null,
    idpGroups: identity?.idpGroups ?? [],
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      lastRunAt: agent.lastRunAt,
    })),
  };
}
