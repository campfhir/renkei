'use server';

/**
 * Organization Usage's report — the operator's tenant-wide counterpart to
 * "My usage". Gated on ROLE_OPERATOR on every call, the same way every
 * other admin action in this app is: a page-level check is not enough on
 * its own, because a server action is reachable on its own.
 */

import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { safeTimeZone } from '../../usage/window';
import {
  getMostEfficientAgents,
  getOrgActivityTotals,
  getOrgDailySeries,
  getOrgTokenTotals,
  getTopAgentsByTokens,
  getTopToolsOrg,
  getTopUsers,
  type EfficientAgentRow,
  type OrgActivityTotals,
  type OrgTokenTotals,
  type OrgToolRow,
  type TopAgentRow,
  type TopUserRow,
} from '@/lib/usage/org-usage';
import { bucketOrgSeries, resolvePeriod, type OrgBucket } from './window';

export interface OrgUsageReport {
  periodKey: string;
  days: number;
  /** The IANA zone every day in the report is bucketed in. */
  timeZone: string;
  tokens: OrgTokenTotals;
  activity: OrgActivityTotals;
  series: OrgBucket[];
  topUsers: TopUserRow[];
  includeAgentsInTopUsers: boolean;
  topAgents: TopAgentRow[];
  efficientAgents: EfficientAgentRow[];
  topTools: OrgToolRow[];
  error?: string;
  signedOut?: boolean;
  forbidden?: boolean;
}

const ZERO_TOKENS: OrgTokenTotals = {
  chat: { input: 0, output: 0 },
  chatProjects: { input: 0, output: 0 },
  codeProjects: { input: 0, output: 0 },
  agents: { input: 0, output: 0 },
};

const ZERO_ACTIVITY: OrgActivityTotals = {
  runs: 0,
  failures: 0,
  toolCalls: 0,
  toolErrors: 0,
  activeUsers: 0,
  totalUsers: 0,
};

export async function getOrgUsageReport(
  tenantId: string,
  requestedPeriod?: string,
  requestedTimeZone?: string,
  includeAgentsInTopUsers = false
): Promise<OrgUsageReport> {
  const period = resolvePeriod(requestedPeriod);
  const timeZone = safeTimeZone(requestedTimeZone);
  const empty: OrgUsageReport = {
    periodKey: period.key,
    days: period.days,
    timeZone,
    tokens: ZERO_TOKENS,
    activity: ZERO_ACTIVITY,
    series: [],
    topUsers: [],
    includeAgentsInTopUsers,
    topAgents: [],
    efficientAgents: [],
    topTools: [],
  };

  const session = await getSessionFromCookies(tenantId);
  if (!session) return { ...empty, error: 'Sign in to see organization usage', signedOut: true };
  if (!(await checkAccess(tenantId, [ROLE_OPERATOR]))) {
    return { ...empty, error: 'Operator access required', forbidden: true };
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return { ...empty, error: 'Database unavailable' };
  const db = dbResult.val;

  try {
    const [tokens, activity, daily, topUsers, topAgents, efficientAgents, topTools] =
      await Promise.all([
        getOrgTokenTotals(db, tenantId, period.days, timeZone),
        getOrgActivityTotals(db, tenantId, period.days, timeZone),
        getOrgDailySeries(db, tenantId, period.days, timeZone),
        getTopUsers(db, tenantId, period.days, timeZone, includeAgentsInTopUsers),
        getTopAgentsByTokens(db, tenantId, period.days, timeZone),
        getMostEfficientAgents(db, tenantId, period.days, timeZone),
        getTopToolsOrg(db, tenantId, period.days, timeZone),
      ]);
    return {
      periodKey: period.key,
      days: period.days,
      timeZone,
      tokens,
      activity,
      series: bucketOrgSeries(daily, period.days, new Date(), timeZone),
      topUsers,
      includeAgentsInTopUsers,
      topAgents,
      efficientAgents,
      topTools,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : 'Could not read usage' };
  }
}
