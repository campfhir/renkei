import React from 'react';
import Link from 'next/link';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { sql } from 'kysely';
import ConnectorIcon from '@/components/connector-icon';
import { grantProviderLabel } from '@/lib/provider-labels';
import BackLink from '@/components/back-link';
import LocalTime from '@/components/local-time';
import AgentUsagePanel from '@/components/agent-usage-panel';
import { friendlyToolName } from '@/lib/tool-name';
import { listAgentsForOwner } from '@/lib/agents/runs-view';
import {
  getAgentTokenUsage,
  getAgentToolUsage,
  getAgentTokenTrend,
} from '@/lib/agents/agent-usage';
import { bucketTokenTrend, TREND_PERIODS } from './trend-window';
import RevokeGrantButton from '../revoke-grant-button';
import TokenTrendChart from './token-trend-chart';

const TOOL_USAGE_WINDOW_DAYS = 30;
const DEFAULT_PERIOD = TREND_PERIODS[0]!;

/** provider_grants.provider → the icon the connector catalog uses. */
const PROVIDER_ICON_KEY: Record<string, string> = {
  atlassian: 'jira',
  'atlassian-jsm': 'jira',
  'atlassian-confluence': 'atlassian-confluence',
  'atlassian-bitbucket': 'atlassian-bitbucket',
  microsoft: 'microsoft',
  webex: 'webex',
  zoom: 'zoom',
  onbase: 'onbase',
  'onbase-admin': 'onbase-admin',
};

function formatMs(ms: number): string {
  if (ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-800">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="truncate text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

/**
 * One person, drilled into: which connectors they have live, which agents
 * they own and each one's status and last run, then the same usage story
 * the agent detail page tells — tokens and tool calls — rolled up across
 * every agent they own instead of just one.
 */
export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ slug: string; subject: string }>;
}): Promise<React.ReactNode> {
  const { slug, subject } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Unable to connect to the database. Please try again later.
        </p>
      </div>
    );
  }
  const db = dbResult.val;

  const [identity, grants, agents, lastActiveRow] = await Promise.all([
    db
      .selectFrom('identities')
      .select(['subject', 'display_name', 'email'])
      .where('tenant_id', '=', tenant.id)
      .where('subject', '=', subject)
      .executeTakeFirst(),
    db
      .selectFrom('provider_grants')
      .select(['provider', 'provider_account_id', 'display_name', 'expires_at', 'created_at'])
      .where('tenant_id', '=', tenant.id)
      .where('subject', '=', subject)
      .orderBy('provider')
      .execute(),
    listAgentsForOwner(db, tenant.id, subject),
    db
      .selectFrom('sessions')
      .select(sql<Date | null>`max(last_used_at)`.as('last_used_at'))
      .where('tenant_id', '=', tenant.id)
      .where('subject', '=', subject)
      .executeTakeFirst(),
  ]);

  if (!identity && grants.length === 0 && agents.length === 0) notFound();

  const name = identity?.display_name || identity?.email || grants[0]?.display_name || subject;
  const email = identity?.email ?? null;
  const lastActive = lastActiveRow?.last_used_at ?? null;

  const agentIds = agents.map((agent) => agent.id);
  const [tokenBuckets, toolUsage, initialTrendDaily] = await Promise.all([
    getAgentTokenUsage(db, tenant.id, agentIds),
    getAgentToolUsage(db, tenant.id, agentIds, TOOL_USAGE_WINDOW_DAYS),
    // Server-rendered in UTC; the chart refetches in the browser's zone on
    // its first interaction and says which zone it shows.
    getAgentTokenTrend(db, tenant.id, agentIds, DEFAULT_PERIOD.days, 'UTC'),
  ]);

  const topTools = [...toolUsage].sort((a, b) => b.calls - a.calls).slice(0, 5);
  const timed = toolUsage.filter((row) => row.calls > 0 && row.p95Ms > 0);
  const slowest = [...timed].sort((a, b) => b.p95Ms - a.p95Ms)[0] ?? null;
  const fastest = [...timed].sort((a, b) => a.p95Ms - b.p95Ms)[0] ?? null;
  const totalCalls = toolUsage.reduce((sum, row) => sum + row.calls, 0);
  const totalErrors = toolUsage.reduce((sum, row) => sum + row.errors, 0);
  const totalTokens = tokenBuckets.input.allTime + tokenBuckets.output.allTime;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <BackLink href={`/${slug}/admin/people`} label="People" />
        <h1 className="min-w-0 truncate text-xl font-bold">{name}</h1>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {email && email !== name ? `${email} · ` : ''}
        {lastActive ? (
          <>
            last active <LocalTime at={lastActive} />
          </>
        ) : (
          'never signed in'
        )}
      </p>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Connectors
        </h2>
        {grants.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-600">No connectors linked</p>
        ) : (
          <ul className="space-y-2">
            {grants.map((grant) => {
              const expired = new Date(grant.expires_at) < new Date();
              return (
                <li
                  key={`${grant.provider}:${grant.provider_account_id}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-800"
                >
                  <ConnectorIcon
                    capabilityKey={PROVIDER_ICON_KEY[grant.provider] ?? grant.provider}
                    label={grantProviderLabel(grant.provider)}
                    size={16}
                  />
                  <span className="font-medium">{grantProviderLabel(grant.provider)}</span>
                  <span className="text-gray-500">{grant.display_name}</span>
                  {expired ? (
                    <span
                      className="text-xs text-amber-700 dark:text-amber-400"
                      title="Token expired; refresh due"
                    >
                      ⚠️ expired
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">
                      expires <LocalTime at={grant.expires_at} format="date" />
                    </span>
                  )}
                  <span className="ml-auto">
                    <RevokeGrantButton
                      slug={slug}
                      provider={grant.provider}
                      providerLabel={grantProviderLabel(grant.provider)}
                      accountId={grant.provider_account_id}
                      displayName={name}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Agents</h2>
        {agents.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-600">No agents owned</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-900 dark:border-gray-800">
            {agents.map((agent) => (
              <li
                key={agent.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <Link
                  href={`/${slug}/admin/agents/${agent.id}`}
                  className="min-w-0 truncate font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  {agent.name}
                </Link>
                <span className="flex shrink-0 items-center gap-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      agent.enabled
                        ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                    }`}
                  >
                    {agent.enabled ? 'On' : 'Off'}
                  </span>
                  <span className="text-xs text-gray-500">
                    {agent.lastRunAt ? (
                      <>
                        last run <LocalTime at={agent.lastRunAt} format="date" />
                      </>
                    ) : (
                      'never run'
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {agents.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Usage, across {agents.length === 1 ? 'this agent' : `all ${agents.length} agents`}
          </h2>

          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Tokens (all time)" value={totalTokens.toLocaleString('en-US')} />
            <Stat
              label={`Tool calls (${TOOL_USAGE_WINDOW_DAYS}d)`}
              value={totalCalls.toLocaleString('en-US')}
              hint={totalErrors > 0 ? `${totalErrors.toLocaleString('en-US')} failed` : undefined}
            />
            <Stat
              label="Slowest (p95)"
              value={slowest ? formatMs(slowest.p95Ms) : '—'}
              hint={slowest ? friendlyToolName(slowest.tool, null) : undefined}
            />
            <Stat
              label="Fastest (p95)"
              value={fastest ? formatMs(fastest.p95Ms) : '—'}
              hint={fastest ? friendlyToolName(fastest.tool, null) : undefined}
            />
          </div>

          <div className="mb-4 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <h3 className="mb-3 text-sm font-semibold">Tokens over time</h3>
            <TokenTrendChart
              tenantId={tenant.id}
              subject={subject}
              agents={agents.map((agent) => ({ id: agent.id, name: agent.name }))}
              initial={{
                periodKey: DEFAULT_PERIOD.key,
                days: DEFAULT_PERIOD.days,
                timeZone: 'UTC',
                points: bucketTokenTrend(initialTrendDaily, DEFAULT_PERIOD.days, new Date(), 'UTC'),
              }}
            />
          </div>

          {topTools.length > 0 && (
            <div className="mb-4 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
              <h3 className="text-sm font-semibold">Top 5 tools</h3>
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                By calls, last {TOOL_USAGE_WINDOW_DAYS} days
              </p>
              <ol className="space-y-2">
                {topTools.map((row) => {
                  const largest = topTools[0]?.calls ?? 1;
                  return (
                    <li key={row.tool}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate" title={row.tool}>
                          {friendlyToolName(row.tool, null)}
                        </span>
                        <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
                          {row.calls.toLocaleString('en-US')}
                        </span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                        <div
                          className="h-full rounded-full bg-blue-500"
                          style={{ width: `${largest > 0 ? (row.calls / largest) * 100 : 0}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            <AgentUsagePanel
              tokens={tokenBuckets}
              tools={toolUsage}
              toolWindowDays={TOOL_USAGE_WINDOW_DAYS}
            />
          </div>
        </section>
      )}
    </div>
  );
}
