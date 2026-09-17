/**
 * Who one person is, for the operator's per-person usage view: the
 * identity spine's name and email, when they last signed in, the groups
 * the IdP reported at that sign-in, the connectors they have linked (with
 * expiry, so an operator can disconnect one from the same card) and the
 * agents they own. This is what the old People page said about a person;
 * it now sits above that person's usage instead of on a page of its own.
 *
 * Someone can exist with no identity row at all — a grant or an agent can
 * outlive its owner's last sign-in — so the lookup unions the three
 * sources and answers null only when none of them knows the subject.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { listAgentsForOwner } from '@/lib/agents/runs-view';

export interface PersonGrant {
  provider: string;
  accountId: string;
  displayName: string | null;
  /** ISO timestamp. */
  expiresAt: string;
  expired: boolean;
}

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
  grants: PersonGrant[];
  agents: PersonAgent[];
}

export async function getPersonProfile(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<PersonProfile | null> {
  const [identity, grants, agents, lastActiveRow] = await Promise.all([
    db
      .selectFrom('identities')
      .select(['subject', 'display_name', 'email', 'idp_groups'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .executeTakeFirst(),
    db
      .selectFrom('provider_grants')
      .select(['provider', 'provider_account_id', 'display_name', 'expires_at'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .orderBy('provider')
      .execute(),
    listAgentsForOwner(db, tenantId, subject),
    db
      .selectFrom('sessions')
      .select(sql<Date | null>`max(last_used_at)`.as('last_used_at'))
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .executeTakeFirst(),
  ]);

  if (!identity && grants.length === 0 && agents.length === 0) return null;

  const now = Date.now();
  return {
    subject,
    name: identity?.display_name || identity?.email || grants[0]?.display_name || subject,
    email: identity?.email ?? null,
    lastActiveAt: lastActiveRow?.last_used_at
      ? new Date(lastActiveRow.last_used_at).toISOString()
      : null,
    idpGroups: identity?.idp_groups ?? [],
    grants: grants.map((grant) => {
      const expiresAt = new Date(grant.expires_at);
      return {
        provider: grant.provider,
        accountId: grant.provider_account_id,
        displayName: grant.display_name,
        expiresAt: expiresAt.toISOString(),
        expired: expiresAt.getTime() < now,
      };
    }),
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      lastRunAt: agent.lastRunAt,
    })),
  };
}
