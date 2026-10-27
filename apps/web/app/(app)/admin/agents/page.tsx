import React from 'react';
import { redirect } from 'next/navigation';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { listAgentsForAdmin } from '@/lib/agents/runs-view';
import {
  getRunTallies,
  getTenantTokenUsage,
  getTokenUsageByAgent,
  getTokenUsageByModel,
} from '@/lib/agents/agent-usage';
import { RetentionForm } from './retention-form';
import OversightCards from './oversight-cards';

/**
 * Agent oversight: every agent in the org, owner-attributed, with run,
 * failure and token tallies. Agents are not confidential (their run
 * CONTENT mostly is — see the run pages); an operator can see what exists
 * and turn a misbehaving one off or back on, never edit it.
 *
 * Run and failure tallies come from the durable run log (migration 083),
 * which survives the run-retention prune, so year and all-time are real.
 * Token tallies come from the token ledger (085), per agent and per model
 * (098, cache breakdown 097) — so the agent that costs the most is a sort
 * away, not a click into each one. This page fetches every bucket; the
 * client cards show one period at a time behind a toggle that drives the
 * org card and every agent card together.
 */

export default async function AdminAgentsPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }

  const agents = await listAgentsForAdmin();
  const settingsResult = await getOrgSettings();

  // Run and failure buckets over the durable run log (migration 083), cut
  // on the database session's calendar — the numbers exist to be read
  // against the per-day cap.
  const [tallies, tokenTotals, tokensByAgent, tokensByModel] = await Promise.all([
    getRunTallies(),
    getTenantTokenUsage(),
    getTokenUsageByAgent(),
    getTokenUsageByModel(null),
  ]);
  const totals = tallies.totals.runs;
  const failureTotals = tallies.totals.failures;
  const dailyCap = settingsResult.ok ? settingsResult.val.agentMaxRunsPerDay : null;
  const runsByAgent = Object.fromEntries(
    Object.entries(tallies.byAgent).map(([agentId, row]) => [agentId, row.runs])
  );
  const failuresByAgent = Object.fromEntries(
    Object.entries(tallies.byAgent).map(([agentId, row]) => [agentId, row.failures])
  );

  const retentionDays = settingsResult.ok
    ? settingsResult.val.agentRunRetentionDays
    : DEFAULT_ORG_SETTINGS.agentRunRetentionDays;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-xl font-bold">Agent oversight</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Every user-drafted agent in this organization. You can view run statuses (step content only
        for failures), see its usage, and turn an agent off or back on; editing stays with its
        owner. Pick a period, then sort the agents by it; an agent&apos;s page breaks its tokens
        down by model and by step.
      </p>

      <OversightCards
        agents={agents}
        runsByAgent={runsByAgent}
        failuresByAgent={failuresByAgent}
        tokensByAgent={tokensByAgent}
        totals={totals}
        failureTotals={failureTotals}
        tokenTotals={tokenTotals}
        tokensByModel={tokensByModel}
        dailyCap={dailyCap}
      />

      <div className="mt-6">
        <RetentionForm current={retentionDays} />
      </div>
    </div>
  );
}
