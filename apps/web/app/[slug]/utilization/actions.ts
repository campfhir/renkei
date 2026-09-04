'use server';

/**
 * The usage page's report — one person's overall utilization.
 *
 * The subject is the SESSION's, never a parameter: this page answers "what
 * have I used", and there is no argument a caller can send that turns it
 * into someone else's answer. Operators who want another person's numbers
 * have the people page, which checks their role on every call.
 */

import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { ROLE_OPERATOR, ROLE_USER } from '@/lib/access';
import { safeTimeZone } from '../usage/window';
import {
  getAgentUtilization,
  getFailureSignatures,
  getUtilizationSeries,
  getUtilizationTotals,
  type AgentUtilizationRow,
  type FailureSignature,
  type UtilizationTotals,
} from '@/lib/usage/user-utilization';
import { bucketUtilization, resolvePeriod, type UtilizationBucket } from './window';

export interface UtilizationReport {
  periodKey: string;
  days: number;
  /** The IANA zone every day in the report is bucketed in. */
  timeZone: string;
  totals: UtilizationTotals;
  series: UtilizationBucket[];
  agents: AgentUtilizationRow[];
  attention: FailureSignature[];
  error?: string;
  signedOut?: boolean;
}

const ZERO: UtilizationTotals = {
  inputTokens: 0,
  outputTokens: 0,
  chatInputTokens: 0,
  chatOutputTokens: 0,
  runs: 0,
  failures: 0,
  toolCalls: 0,
  toolErrors: 0,
};

export async function getUtilizationReport(
  tenantId: string,
  requestedPeriod?: string,
  requestedTimeZone?: string
): Promise<UtilizationReport> {
  const period = resolvePeriod(requestedPeriod);
  // The viewer's zone, validated (an unknown name would fail the query):
  // every ledger is bucketed in it, so "today" means their today.
  const timeZone = safeTimeZone(requestedTimeZone);
  const empty: UtilizationReport = {
    periodKey: period.key,
    days: period.days,
    timeZone,
    totals: ZERO,
    series: [],
    agents: [],
    attention: [],
  };

  const session = await getSessionFromCookies(tenantId);
  if (!session) return { ...empty, error: 'Sign in to see your usage', signedOut: true };
  if (!session.roles.includes(ROLE_OPERATOR) && !session.roles.includes(ROLE_USER)) {
    return { ...empty, error: 'Your account has no role in this tenant' };
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) return { ...empty, error: 'Database unavailable' };
  const db = dbResult.val;
  const subject = session.subject;

  try {
    const [totals, daily, agents, attention] = await Promise.all([
      getUtilizationTotals(db, tenantId, subject, period.days, timeZone),
      getUtilizationSeries(db, tenantId, subject, period.days, timeZone),
      getAgentUtilization(db, tenantId, subject, period.days, timeZone),
      getFailureSignatures(db, tenantId, subject, period.days, timeZone),
    ]);
    return {
      periodKey: period.key,
      days: period.days,
      timeZone,
      totals,
      series: bucketUtilization(daily, period.days, new Date(), timeZone),
      agents,
      attention,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : 'Could not read usage' };
  }
}
