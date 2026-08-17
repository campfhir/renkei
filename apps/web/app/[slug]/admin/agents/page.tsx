import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
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
