'use server';

/**
 * The person page's token trend chart, refetched from the client when the
 * period or the agent breakdown changes — the same shape the tools page's
 * `getUsageReport` refresh uses.
 *
 * Access is re-checked HERE from the session, never trusted from the page
 * that rendered the button: an operator role is required on every call, not
 * just the first one. `agentId`, if given, is validated against the
 * person's OWN agent roster before it is used to filter anything — a
 * tampered id for someone else's agent silently falls back to "all of this
 * person's agents" rather than leaking another owner's totals.
 */

import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { ROLE_OPERATOR } from '@/lib/access';
import { getAgentTokenTrend } from '@/lib/agents/agent-usage';
import { listAgentsForOwner } from '@/lib/agents/runs-view';
import { resolveTrendDays, bucketTokenTrend, type TrendBucket } from './trend-window';

export interface PersonTrendReport {
  periodKey: string;
  days: number;
  points: TrendBucket[];
  error?: string;
  signedOut?: boolean;
}

export async function getPersonTokenTrend(
  tenantId: string,
  subject: string,
  periodKey: string,
  agentId: string | null
): Promise<PersonTrendReport> {
  const days = resolveTrendDays(periodKey);
  const empty: PersonTrendReport = { periodKey, days, points: [] };

  const session = await getSessionFromCookies(tenantId);
  if (!session) return { ...empty, error: 'Sign in again', signedOut: true };
  if (!session.roles.includes(ROLE_OPERATOR)) {
    return { ...empty, error: 'Your account cannot see this' };
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return { ...empty, error: 'Database unavailable' };
  const db = dbResult.val;

  try {
    const agents = await listAgentsForOwner(db, tenantId, subject);
    const ownedIds = agents.map((agent) => agent.id);
    const targetIds = agentId && ownedIds.includes(agentId) ? [agentId] : ownedIds;

    const daily = await getAgentTokenTrend(db, tenantId, targetIds, days);
    return { periodKey, days, points: bucketTokenTrend(daily, days, new Date()) };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : 'Could not read usage' };
  }
}
