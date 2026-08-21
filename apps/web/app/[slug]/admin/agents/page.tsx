import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { listAgentsForAdmin } from '@/lib/agents/runs-view';
import { AdminAgentActions } from './admin-agent-actions';
import { RetentionForm } from './retention-form';
import LocalTime from '@/components/local-time';

/**
 * Agent oversight: every agent in the org, owner-attributed, with the
 * week's failure count. Agents are not confidential (their run CONTENT
 * mostly is — see the run pages); an operator can see what exists and
 * turn a misbehaving one off, never edit it.
 */
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

  // Org-wide run tallies from the durable counters (migration 049) — the
  // numbers an operator reads against the per-day cap. Counter rows survive
  // the run-retention prune, so year/all-time are real.
  const totalsResult = await sql<{
    today: string;
    week: string;
    month: string;
    quarter: string;
    year: string;
    all_time: string;
  }>`
    SELECT
      COALESCE(SUM(runs) FILTER (WHERE day = CURRENT_DATE), 0) AS today,
      COALESCE(SUM(runs) FILTER (WHERE day >= date_trunc('week', CURRENT_DATE)), 0) AS week,
      COALESCE(SUM(runs) FILTER (WHERE day >= date_trunc('month', CURRENT_DATE)), 0) AS month,
      COALESCE(SUM(runs) FILTER (WHERE day >= date_trunc('quarter', CURRENT_DATE)), 0) AS quarter,
      COALESCE(SUM(runs) FILTER (WHERE day >= date_trunc('year', CURRENT_DATE)), 0) AS year,
      COALESCE(SUM(runs), 0) AS all_time
    FROM agent_run_counters
    WHERE tenant_id = ${tenant.id}
  `.execute(dbResult.val);
  const totalsRow = totalsResult.rows[0];
  const totals = [
    { label: 'Today', count: Number(totalsRow?.today ?? 0) },
    { label: 'This week', count: Number(totalsRow?.week ?? 0) },
    { label: 'This month', count: Number(totalsRow?.month ?? 0) },
    { label: 'This quarter', count: Number(totalsRow?.quarter ?? 0) },
    { label: 'This year', count: Number(totalsRow?.year ?? 0) },
    { label: 'All time', count: Number(totalsRow?.all_time ?? 0) },
  ];
  const dailyCap = settingsResult.ok ? settingsResult.val.agentMaxRunsPerDay : null;

  const perAgentResult = await sql<{ agent_id: string; today: string; all_time: string }>`
    SELECT agent_id,
      COALESCE(SUM(runs) FILTER (WHERE day = CURRENT_DATE), 0) AS today,
      COALESCE(SUM(runs), 0) AS all_time
    FROM agent_run_counters
    WHERE tenant_id = ${tenant.id}
    GROUP BY agent_id
  `.execute(dbResult.val);
  const runsByAgent = new Map(
    perAgentResult.rows.map((row) => [
      row.agent_id,
      { today: Number(row.today), allTime: Number(row.all_time) },
    ])
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

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Runs started, all agents together
        </p>
        <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {totals.map((bucket) => (
            <div
              key={bucket.label}
              className="rounded-md bg-gray-50 px-2 py-1.5 text-center dark:bg-gray-900"
            >
              <dd className="text-base font-semibold tabular-nums">
                {bucket.count.toLocaleString('en-US')}
              </dd>
              <dt className="text-[11px] text-gray-500 dark:text-gray-400">{bucket.label}</dt>
            </div>
          ))}
        </dl>
        {dailyCap !== null ? (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            The org-wide cap is {dailyCap.toLocaleString('en-US')} runs per day — adjustable in
            Settings.
          </p>
        ) : null}
      </div>

      {agents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No agents drafted yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-3">Agent</th>
                <th className="py-2 pr-3">Owner</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3">Runs today</th>
                <th className="py-2 pr-3">All time</th>
                <th className="py-2 pr-3">Failures (7d)</th>
                <th className="py-2 pr-3">Last run</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-2 pr-3">
                    <Link
                      href={`/${slug}/admin/agents/${agent.id}/runs`}
                      className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {agent.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                    {agent.ownerEmail ?? agent.ownerSubject}
                  </td>
                  <td className="py-2 pr-3">{agent.enabled ? 'On' : 'Off'}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {(runsByAgent.get(agent.id)?.today ?? 0).toLocaleString('en-US')}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {(runsByAgent.get(agent.id)?.allTime ?? 0).toLocaleString('en-US')}
                  </td>
                  <td className="py-2 pr-3">
                    {agent.recentFailures > 0 ? (
                      <span className="font-medium text-red-600 dark:text-red-400">
                        {agent.recentFailures}
                      </span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td className="py-2 pr-3 text-gray-500">
                    {agent.lastRunAt ? <LocalTime at={agent.lastRunAt} /> : '—'}
                  </td>
                  <td className="py-2 text-right">
                    {agent.enabled ? <AdminAgentActions slug={slug} agentId={agent.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RetentionForm slug={slug} current={retentionDays} />
    </div>
  );
}
