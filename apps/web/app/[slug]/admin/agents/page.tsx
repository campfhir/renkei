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
 * Agent oversight: every agent in the org, owner-attributed, with run
 * tallies and the week's failure count. Agents are not confidential (their
 * run CONTENT mostly is — see the run pages); an operator can see what
 * exists and turn a misbehaving one off, never edit it.
 *
 * Run tallies come from the durable counters (migration 049) — counter
 * rows survive the run-retention prune, so year/all-time are real. This
 * page fetches every bucket; the client table shows one at a time behind
 * a period toggle.
 */

interface BucketRow {
  today: string;
  week: string;
  month: string;
  quarter: string;
  year: string;
  all_time: string;
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

const BUCKET_COLUMNS = sql`
  COALESCE(SUM(runs) FILTER (WHERE day = CURRENT_DATE), 0) AS today,
  COALESCE(SUM(runs) FILTER (WHERE day >= date_trunc('week', CURRENT_DATE)), 0) AS week,
  COALESCE(SUM(runs) FILTER (WHERE day >= date_trunc('month', CURRENT_DATE)), 0) AS month,
  COALESCE(SUM(runs) FILTER (WHERE day >= date_trunc('quarter', CURRENT_DATE)), 0) AS quarter,
  COALESCE(SUM(runs) FILTER (WHERE day >= date_trunc('year', CURRENT_DATE)), 0) AS year,
  COALESCE(SUM(runs), 0) AS all_time
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

  const totalsResult = await sql<BucketRow>`
    SELECT ${BUCKET_COLUMNS}
    FROM agent_run_counters
    WHERE tenant_id = ${tenant.id}
  `.execute(dbResult.val);
  const totals = toBuckets(totalsResult.rows[0]);
  const dailyCap = settingsResult.ok ? settingsResult.val.agentMaxRunsPerDay : null;

  const perAgentResult = await sql<BucketRow & { agent_id: string }>`
    SELECT agent_id, ${BUCKET_COLUMNS}
    FROM agent_run_counters
    WHERE tenant_id = ${tenant.id}
    GROUP BY agent_id
  `.execute(dbResult.val);
  const runsByAgent = Object.fromEntries(
    perAgentResult.rows.map((row) => [row.agent_id, toBuckets(row)])
  );

  const retentionDays = settingsResult.ok
    ? settingsResult.val.agentRunRetentionDays
    : DEFAULT_ORG_SETTINGS.agentRunRetentionDays;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-xl font-bold">Agent oversight</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Every user-drafted agent in this organization. You can view run statuses (step content only
        for failures) and turn an agent off; editing stays with its owner.
      </p>

      <OversightTable
        slug={slug}
        agents={agents}
        runsByAgent={runsByAgent}
        totals={totals}
        dailyCap={dailyCap}
      />

      <RetentionForm slug={slug} current={retentionDays} />
    </div>
  );
}
