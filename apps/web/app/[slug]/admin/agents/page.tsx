import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { listAgentsForAdmin } from '@/lib/agents/runs-view';
import { RetentionForm } from './retention-form';
import OversightTable, { type RunBuckets } from './oversight-table';

/**
 * Agent oversight: every agent in the org, owner-attributed, with run and
 * failure tallies. Agents are not confidential (their run CONTENT mostly
 * is — see the run pages); an operator can see what exists and turn a
 * misbehaving one off, never edit it.
 *
 * Run and failure tallies come from the durable counters (migrations 049
 * and 050) — counter rows survive the run-retention prune, so year and
 * all-time are real. This page fetches every bucket; the client table
 * shows one period at a time behind a toggle that drives the org total,
 * the Runs column and the Failures column together.
 */

interface BucketRow {
  today: string;
  week: string;
  month: string;
  quarter: string;
  year: string;
  all_time: string;
  failed_today: string;
  failed_week: string;
  failed_month: string;
  failed_quarter: string;
  failed_year: string;
  failed_all_time: string;
}

interface TokenBucketRow {
  in_today: string;
  in_week: string;
  in_month: string;
  in_quarter: string;
  in_year: string;
  in_all_time: string;
  out_today: string;
  out_week: string;
  out_month: string;
  out_quarter: string;
  out_year: string;
  out_all_time: string;
}

function toBuckets(row: BucketRow | undefined): RunBuckets {
  return {
    today: Number(row?.today ?? 0),
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
    week: Number(row?.failed_week ?? 0),
    month: Number(row?.failed_month ?? 0),
    quarter: Number(row?.failed_quarter ?? 0),
    year: Number(row?.failed_year ?? 0),
    allTime: Number(row?.failed_all_time ?? 0),
  };
}

function toTokenInBuckets(row: TokenBucketRow | undefined): RunBuckets {
  return {
    today: Number(row?.in_today ?? 0),
    week: Number(row?.in_week ?? 0),
    month: Number(row?.in_month ?? 0),
    quarter: Number(row?.in_quarter ?? 0),
    year: Number(row?.in_year ?? 0),
    allTime: Number(row?.in_all_time ?? 0),
  };
}

function toTokenOutBuckets(row: TokenBucketRow | undefined): RunBuckets {
  return {
    today: Number(row?.out_today ?? 0),
    week: Number(row?.out_week ?? 0),
    month: Number(row?.out_month ?? 0),
    quarter: Number(row?.out_quarter ?? 0),
    year: Number(row?.out_year ?? 0),
    allTime: Number(row?.out_all_time ?? 0),
  };
}

/**
 * Run and failure buckets over the durable run log (migration 083), cut on
 * the database session's calendar the way the per-day counters they
 * replace were — the numbers exist to be read against the per-day cap.
 */
const BUCKET_COLUMNS = sql`
  COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today,
  COUNT(*) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)) AS week,
  COUNT(*) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)) AS month,
  COUNT(*) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)) AS quarter,
  COUNT(*) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)) AS year,
  COUNT(*) AS all_time,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date = CURRENT_DATE) AS failed_today,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date >= date_trunc('week', CURRENT_DATE)) AS failed_week,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date >= date_trunc('month', CURRENT_DATE)) AS failed_month,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date >= date_trunc('quarter', CURRENT_DATE)) AS failed_quarter,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at::date >= date_trunc('year', CURRENT_DATE)) AS failed_year,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed_all_time
`;

/** The same buckets over the token ledger (migration 085). */
const TOKEN_BUCKET_COLUMNS = sql`
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS in_today,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)), 0) AS in_week,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)), 0) AS in_month,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)), 0) AS in_quarter,
  COALESCE(SUM(input_tokens) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)), 0) AS in_year,
  COALESCE(SUM(input_tokens), 0) AS in_all_time,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS out_today,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('week', CURRENT_DATE)), 0) AS out_week,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('month', CURRENT_DATE)), 0) AS out_month,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('quarter', CURRENT_DATE)), 0) AS out_quarter,
  COALESCE(SUM(output_tokens) FILTER (WHERE created_at::date >= date_trunc('year', CURRENT_DATE)), 0) AS out_year,
  COALESCE(SUM(output_tokens), 0) AS out_all_time
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
  const agents = await listAgentsForAdmin(dbResult.val, tenant.id);
  const settingsResult = await getOrgSettings(tenant.id);

  const [totalsResult, tokenTotalsResult] = await Promise.all([
    sql<BucketRow>`
      SELECT ${BUCKET_COLUMNS}
      FROM agent_run_log
      WHERE tenant_id = ${tenant.id}
    `.execute(dbResult.val),
    sql<TokenBucketRow>`
      SELECT ${TOKEN_BUCKET_COLUMNS}
      FROM llm_calls
      WHERE tenant_id = ${tenant.id}
    `.execute(dbResult.val),
  ]);
  const totals = toBuckets(totalsResult.rows[0]);
  const failureTotals = toFailureBuckets(totalsResult.rows[0]);
  const tokenInTotals = toTokenInBuckets(tokenTotalsResult.rows[0]);
  const tokenOutTotals = toTokenOutBuckets(tokenTotalsResult.rows[0]);
  const dailyCap = settingsResult.ok ? settingsResult.val.agentMaxRunsPerDay : null;

  const perAgentResult = await sql<BucketRow & { agent_id: string }>`
    SELECT agent_id, ${BUCKET_COLUMNS}
    FROM agent_run_log
    WHERE tenant_id = ${tenant.id}
    GROUP BY agent_id
  `.execute(dbResult.val);
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
        owner.
      </p>

      <OversightTable
        slug={slug}
        agents={agents}
        runsByAgent={runsByAgent}
        failuresByAgent={failuresByAgent}
        totals={totals}
        failureTotals={failureTotals}
        tokenInTotals={tokenInTotals}
        tokenOutTotals={tokenOutTotals}
        dailyCap={dailyCap}
      />

      <RetentionForm slug={slug} current={retentionDays} />
    </div>
  );
}
