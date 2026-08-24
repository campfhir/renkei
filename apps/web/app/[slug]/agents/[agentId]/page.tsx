import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { sql, type Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getAgent, readShareToken } from '@/lib/agents/store';
import { listRunsForOwner } from '@/lib/agents/runs-view';
import { parseReviewNotes } from '@/lib/agents/notes';
import { Icon, ICONS } from '@/components/icons';
import { triggerBadge, triggerSummary } from '@/lib/agents/trigger-summary';
import CollapsibleSection from '@/components/collapsible-section';
import MemoryPanel from './memory-panel';
import KnowledgePanel from './knowledge-panel';
import ShareAgentButton from './share-agent';
import RecentRuns from './recent-runs';
import StepsOutline from './steps-outline';

interface InvocationCounts {
  today: number;
  week: number;
  month: number;
  quarter: number;
  year: number;
  allTime: number;
  /** Runs started org-wide today, for reading against the daily cap. */
  orgToday: number;
}

/**
 * Run tallies from the durable counters (migration 049), which survive the
 * run-retention prune — that survival is what makes the quarterly/yearly/
 * all-time numbers real rather than "since retention began". Calendar
 * buckets, not trailing windows, because the numbers exist to be read
 * against the org's per-day cap, which is calendar-shaped in spirit.
 */
async function invocationCountsOf(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<InvocationCounts> {
  const result = await sql<{
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
    WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
  `.execute(db);
  const row = result.rows[0];
  const orgResult = await sql<{ total: string }>`
    SELECT COALESCE(SUM(runs), 0) AS total
    FROM agent_run_counters
    WHERE tenant_id = ${tenantId} AND day = CURRENT_DATE
  `.execute(db);
  return {
    today: Number(row?.today ?? 0),
    week: Number(row?.week ?? 0),
    month: Number(row?.month ?? 0),
    quarter: Number(row?.quarter ?? 0),
    year: Number(row?.year ?? 0),
    allTime: Number(row?.all_time ?? 0),
    orgToday: Number(orgResult.rows[0]?.total ?? 0),
  };
}

/**
 * The readable overview of one agent. Steps are the main column — the
 * recipe people came to read; everything contextual (review notes,
 * knowledge, memory, recent runs) sits in a right rail of collapsible
 * sections. On phones the rail stacks first (it's short; the steps are
 * long) and the sections open as modals instead of accordions.
 */
export default async function AgentOverviewPage({
  params,
}: {
  params: Promise<{ slug: string; agentId: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/agents/${agentId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const agent = await getAgent(dbResult.val, tenant.id, session.subject, agentId);
  if (!agent) notFound();

  const [shareToken, recentRuns, invocations, settingsResult] = await Promise.all([
    readShareToken(dbResult.val, tenant.id, session.subject, agentId),
    listRunsForOwner(dbResult.val, tenant.id, session.subject, agentId, { limit: 5 }),
    invocationCountsOf(dbResult.val, tenant.id, agentId),
    getOrgSettings(tenant.id),
  ]);
  const reviewNotes = parseReviewNotes(agent.reviewNotes);
  const dailyCap = settingsResult.ok ? settingsResult.val.agentMaxRunsPerDay : null;
  const invocationRows: { label: string; count: number }[] = [
    { label: 'Today', count: invocations.today },
    { label: 'This week', count: invocations.week },
    { label: 'This month', count: invocations.month },
    { label: 'This quarter', count: invocations.quarter },
    { label: 'This year', count: invocations.year },
    { label: 'All time', count: invocations.allTime },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            href={`/${slug}/agents`}
            aria-label="All agents"
            title="Back to all agents"
            className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.chevronLeft} />
          </Link>
          <h1 className="min-w-0 truncate text-xl font-bold">{agent.name}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              agent.enabled
                ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
            }`}
          >
            {agent.enabled ? 'On' : 'Off'}
          </span>
          <ShareAgentButton
            slug={slug}
            tenantId={tenant.id}
            agentId={agentId}
            initialToken={shareToken === 'NOT_FOUND' ? null : shareToken}
          />
          <Link
            href={`/${slug}/agents/${agentId}/edit`}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700"
          >
            <Icon path={ICONS.pencil} />
            Edit
          </Link>
        </div>
      </div>

      {agent.description ? (
        <p className="mb-6 rounded-md bg-gray-50 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">
          {agent.description}
        </p>
      ) : null}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
        {/* The rail is FIRST in the DOM so it stacks above the steps on
            phones; on lg the explicit grid placement puts it right. */}
        <aside className="mb-6 lg:col-start-2 lg:row-start-1 lg:mb-0">
          {/* When does it run — the schedule/event answer the card view has
              but this page was missing. */}
          <div className="mb-3 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Runs
            </p>
            {agent.triggers.length > 0 ? (
              <ul className="mt-1 space-y-2">
                {agent.triggers.map((trigger) => (
                  <li key={trigger.id} className="text-sm text-gray-800 dark:text-gray-200">
                    <span className="mr-2 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                      {triggerBadge(trigger.draft.kind)}
                    </span>
                    {triggerSummary(trigger.draft)}
                    {!trigger.enabled ? (
                      <span className="ml-2 text-xs text-gray-400">(off)</span>
                    ) : null}
                    {trigger.lastError ? (
                      <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">
                        Last error: {trigger.lastError}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                No triggers — runs only when started by hand.
              </p>
            )}
          </div>

          {reviewNotes.length > 0 ? (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Worth checking
              </p>
              <ul className="mt-1 list-disc space-y-2 pl-5 text-sm text-amber-900 dark:text-amber-200">
                {reviewNotes.map((note) => (
                  <li key={note.issue}>
                    {note.issue}
                    {note.fix ? (
                      <p className="mt-0.5 text-xs text-amber-700/80 dark:text-amber-300/70">
                        Suggestion: {note.fix}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {agent.guardrails || agent.blockedTools.length > 0 ? (
            <CollapsibleSection title="Guardrails & context">
              {agent.blockedTools.length > 0 ? (
                <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">
                  <span className="font-medium">Blocked skills:</span>{' '}
                  {agent.blockedTools.join(', ')}
                </p>
              ) : null}
              {agent.guardrails ? (
                <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                  {agent.guardrails}
                </pre>
              ) : null}
            </CollapsibleSection>
          ) : null}

          <CollapsibleSection title="Knowledge">
            <KnowledgePanel tenantId={tenant.id} agentId={agentId} />
          </CollapsibleSection>

          <CollapsibleSection title="Memory">
            <MemoryPanel tenantId={tenant.id} agentId={agentId} />
          </CollapsibleSection>

          <CollapsibleSection title="Invocations">
            <dl className="grid grid-cols-3 gap-2">
              {invocationRows.map((row) => (
                <div
                  key={row.label}
                  className="rounded-md bg-gray-50 px-2 py-1.5 text-center dark:bg-gray-900"
                >
                  <dd className="text-base font-semibold tabular-nums">
                    {row.count.toLocaleString('en-US')}
                  </dd>
                  <dt className="text-[11px] text-gray-500 dark:text-gray-400">{row.label}</dt>
                </div>
              ))}
            </dl>
            {dailyCap !== null ? (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                All agents together today: {invocations.orgToday.toLocaleString('en-US')} of the{' '}
                {dailyCap.toLocaleString('en-US')}-per-day cap.
              </p>
            ) : null}
          </CollapsibleSection>

          <CollapsibleSection title="Recent runs" defaultOpen>
            <RecentRuns slug={slug} agentId={agentId} runs={recentRuns} />
          </CollapsibleSection>
        </aside>

        <div className="lg:col-start-1 lg:row-start-1">
          <h2 className="mb-2 text-sm font-semibold">Steps</h2>
          <StepsOutline doc={agent.steps} />
        </div>
      </div>
    </div>
  );
}
