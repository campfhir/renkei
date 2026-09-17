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

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { listAgentsForOwner } from '@/lib/agents/runs-view';

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

export async function getPersonProfile(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<PersonProfile | null> {
  const [identity, grantName, agents, lastActiveRow] = await Promise.all([
    db
      .selectFrom('identities')
      .select(['subject', 'display_name', 'email', 'idp_groups'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .executeTakeFirst(),
    // A grant's display name is the fallback name for someone who never
    // signed in — and proof they exist at all.
    db
      .selectFrom('provider_grants')
      .select('display_name')
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .orderBy('provider')
      .executeTakeFirst(),
    listAgentsForOwner(db, tenantId, subject),
    db
      .selectFrom('sessions')
      .select(sql<Date | null>`max(last_used_at)`.as('last_used_at'))
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .executeTakeFirst(),
  ]);

  if (!identity && !grantName && agents.length === 0) return null;

  return {
    subject,
    name: identity?.display_name || identity?.email || grantName?.display_name || subject,
    email: identity?.email ?? null,
    lastActiveAt: lastActiveRow?.last_used_at
      ? new Date(lastActiveRow.last_used_at).toISOString()
      : null,
    idpGroups: identity?.idp_groups ?? [],
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      lastRunAt: agent.lastRunAt,
    })),
  };
}
