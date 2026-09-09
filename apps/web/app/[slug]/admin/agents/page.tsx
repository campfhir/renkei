import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { listAgentsForAdmin } from '@/lib/agents/runs-view';
import {
  getTenantTokenUsage,
  getTokenUsageByAgent,
  getTokenUsageByModel,
} from '@/lib/agents/agent-usage';
import { RetentionForm } from './retention-form';
import OversightCards, { type RunBuckets } from './oversight-cards';

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

interface BucketRow {
  today: string;
  yesterday: string;
  week: string;
  month: string;
  quarter: string;
  year: string;
  all_time: string;
  failed_today: string;
  failed_yesterday: string;
  failed_week: string;
  failed_month: string;
  failed_quarter: string;
  failed_year: string;
  failed_all_time: string;
}

function toBuckets(row: BucketRow | undefined): RunBuckets {
  return {
    today: Number(row?.today ?? 0),
    yesterday: Number(row?.yesterday ?? 0),
    week: Number(row?.week ?? 0),
    month: Number(row?.month ?? 0),
    quarter: Number(row?.quarter ?? 0),
    year: Number(row?.year ?? 0),
    allTime: Number(row?.all_time ?? 0),
  };
}

function toFailureBuckets(row: BucketRow | undefined): RunBuckets {
  return {
    today: Number(row?.failed_today ?? 0),
    yesterday: Number(row?.failed_yesterday ?? 0),
    week: Number(row?.failed_week ?? 0),
    month: Number(row?.failed_month ?? 0),
    quarter: Number(row?.failed_quarter ?? 0),
    year: Number(row?.failed_year ?? 0),
    allTime: Number(row?.failed_all_time ?? 0),
  };
}

/**
 * Run and failure buckets over the durable run log (migration 083), cut on
 * the database session's calendar the way the per-day counters they
 * replace were — the numbers exist to be read against the per-day cap.
 */
const BUCKET_COLUMNS = sql`
  COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today,
  COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE - 1) AS yesterday,
  COUNT(*) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)) AS week,
  COUNT(*) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)) AS month,
  COUNT(*) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)) AS quarter,
  COUNT(*) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)) AS year,
  COUNT(*) AS all_time,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date = CURRENT_DATE) AS failed_today,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date = CURRENT_DATE - 1) AS failed_yesterday,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date >= date_trunc('week', CURRENT_DATE)) AS failed_week,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date >= date_trunc('month', CURRENT_DATE)) AS failed_month,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date >= date_trunc('quarter', CURRENT_DATE)) AS failed_quarter,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date >= date_trunc('year', CURRENT_DATE)) AS failed_year,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed_all_time
`;

export default async function AdminAgentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  const agents = await listAgentsForAdmin(db, tenant.id);
  const settingsResult = await getOrgSettings(tenant.id);

  const [totalsResult, perAgentResult, tokenTotals, tokensByAgent, tokensByModel] =
    await Promise.all([
      sql<BucketRow>`
        SELECT ${BUCKET_COLUMNS}
        FROM agent_run_log
        WHERE tenant_id = ${tenant.id}
      `.execute(db),
      sql<BucketRow & { agent_id: string }>`
        SELECT agent_id, ${BUCKET_COLUMNS}
        FROM agent_run_log
        WHERE tenant_id = ${tenant.id}
        GROUP BY agent_id
      `.execute(db),
      getTenantTokenUsage(db, tenant.id),
      getTokenUsageByAgent(db, tenant.id),
      getTokenUsageByModel(db, tenant.id, null),
    ]);
  const totals = toBuckets(totalsResult.rows[0]);
  const failureTotals = toFailureBuckets(totalsResult.rows[0]);
  const dailyCap = settingsResult.ok ? settingsResult.val.agentMaxRunsPerDay : null;
  const runsByAgent = Object.fromEntries(
    perAgentResult.rows.map((row) => [row.agent_id, toBuckets(row)])
  );
  const failuresByAgent = Object.fromEntries(
    perAgentResult.rows.map((row) => [row.agent_id, toFailureBuckets(row)])
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
        slug={slug}
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
        <RetentionForm slug={slug} current={retentionDays} />
      </div>
    </div>
  );
}
