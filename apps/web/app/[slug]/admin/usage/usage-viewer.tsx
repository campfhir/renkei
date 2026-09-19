'use client';

/**
 * Organization Usage: how much the org is spending, how much of it is
 * actually being used, and who and what is driving it — and, with a
 * person picked, the same view scoped to that one person, along with who
 * they are (their groups and agents; their connectors are on the Access
 * page). The tenant-wide counterpart to "My usage"
 * (utilization/utilization-viewer.tsx) — same shape (period picker,
 * headline tiles, one chart behind a series toggle), plus the
 * leaderboards a person's own page has no reason to show.
 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { getOrgUsageReport, type OrgUsageReport } from './actions';
import {
  ORG_USAGE_PERIODS,
  activeSummary,
  activeUserPercent,
  formatTokens,
  periodCaption,
  type OrgBucket,
  type RankedUserRow,
} from './window';
import type {
  EfficientAgentRow,
  ModelTokenRow,
  OrgToolRow,
  TopAgentRow,
} from '@/lib/usage/org-usage';
import type { PersonProfile } from '@/lib/usage/person-profile';
import { modelLabel } from '@/lib/agents/model-label';
import { TokenSurfaceBreakdown } from '@/components/token-surface-breakdown';
import { VoiceUsageCard } from '@/components/voice-usage-card';
import { Leaderboard } from '@/components/leaderboard';
import { boardRows, formatDuration, type RankedVoiceUserRow } from '@/lib/usage/voice-window';
import { ActivityCalendar } from '@/components/activity-calendar';
import LocalTime from '@/components/local-time';
import { LoadingLine } from '@/components/skeleton';

type Series = 'tokens' | 'runs' | 'tools';

const SERIES: { key: Series; label: string }[] = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'runs', label: 'Agent runs' },
  { key: 'tools', label: 'Tool calls' },
];

const TOKEN_SEGMENTS: {
  key: 'chatTokens' | 'chatProjectTokens' | 'codeProjectTokens' | 'agentTokens';
  label: string;
  className: string;
}[] = [
  { key: 'chatTokens', label: 'Chat', className: 'bg-blue-500' },
  { key: 'chatProjectTokens', label: 'Chat projects', className: 'bg-teal-500' },
  { key: 'codeProjectTokens', label: 'Code projects', className: 'bg-amber-500' },
  { key: 'agentTokens', label: 'Agents', className: 'bg-purple-500' },
];

interface Segment {
  label: string;
  value: number;
  className: string;
}

function legendFor(series: Series): { label: string; className: string }[] {
  if (series === 'tokens')
    return TOKEN_SEGMENTS.map(({ label, className }) => ({ label, className }));
  if (series === 'runs')
    return [
      { label: 'Succeeded', className: 'bg-blue-500' },
      { label: 'Failed', className: 'bg-red-500' },
    ];
  return [
    { label: 'OK', className: 'bg-blue-500' },
    { label: 'Failed', className: 'bg-red-500' },
  ];
}

function segmentsOf(bucket: OrgBucket, series: Series): Segment[] {
  if (series === 'tokens') {
    return TOKEN_SEGMENTS.map((seg) => ({
      label: seg.label,
      value: bucket[seg.key],
      className: seg.className,
    }));
  }
  if (series === 'runs') {
    return [
      {
        label: 'Succeeded',
        value: Math.max(0, bucket.runs - bucket.failures),
        className: 'bg-blue-500',
      },
      { label: 'Failed', value: bucket.failures, className: 'bg-red-500' },
    ];
  }
  return [
    {
      label: 'OK',
      value: Math.max(0, bucket.toolCalls - bucket.toolErrors),
      className: 'bg-blue-500',
    },
    { label: 'Failed', value: bucket.toolErrors, className: 'bg-red-500' },
  ];
}

/**
 * Stacked bars, one series at a time, no chart dependency — the same
 * inline-CSS shape every usage surface in this app already uses. Segments
 * are drawn in reverse order (last first in the DOM) so `justify-end`
 * anchors the base of the stack to the bar's bottom and the first-listed
 * category ends up on top, which is where its rounded corner belongs.
 */
function Chart({ points, series }: { points: OrgBucket[]; series: Series }) {
  const legend = legendFor(series);
  const rows = points.map((point) => segmentsOf(point, series));
  const totals = rows.map((segments) => segments.reduce((sum, seg) => sum + seg.value, 0));
  const peak = Math.max(1, ...totals);
  if (points.length === 0 || totals.every((total) => total === 0)) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Nothing in this period.</p>;
  }
  return (
    <div>
      <div
        className="flex h-40 items-end gap-px"
        role="img"
        aria-label={`${legend.map((entry) => entry.label).join(', ')} over time`}
      >
        {points.map((point, index) => {
          const segments = rows[index]!;
          const total = totals[index]!;
          const height = (total / peak) * 100;
          const tooltip = `${point.label}: ${segments
            .filter((seg) => seg.value > 0)
            .map((seg) => `${seg.label} ${seg.value.toLocaleString('en-US')}`)
            .join(', ')}`;
          return (
            <div
              key={point.bucket}
              className="group relative flex-1"
              style={{ height: '100%' }}
              title={tooltip || point.label}
            >
              <div
                className="absolute inset-x-0 bottom-0 flex flex-col justify-end"
                style={{ height: '100%' }}
              >
                {[...segments].reverse().map((seg, idx) => (
                  <div
                    key={seg.label}
                    className={`w-full ${seg.className} ${idx === 0 ? 'rounded-t-sm' : ''}`}
                    style={{ height: `${total > 0 ? (seg.value / total) * height : 0}%` }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
        {legend.map((entry) => (
          <span key={entry.label} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-sm ${entry.className}`} /> {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-800">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

/**
 * Who the selected person is: identity, groups and the agents they own.
 * Their connectors live on the Access page, which is linked from here.
 */
function PersonCard({
  slug,
  subject,
  person,
}: {
  slug: string;
  subject: string;
  person: PersonProfile | null;
}) {
  const name = person?.name ?? subject;
  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="min-w-0 truncate text-base font-semibold">{name}</h2>
        {person?.email && person.email !== name && (
          <span className="break-all text-sm text-gray-500">{person.email}</span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-gray-500">
          <span>
            {person?.lastActiveAt ? (
              <>
                last active <LocalTime at={person.lastActiveAt} />
              </>
            ) : (
              'never signed in'
            )}
          </span>
          <Link
            href={`/${slug}/admin/access`}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Connectors on Access
          </Link>
        </span>
      </div>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Groups (IdP)
          </h3>
          {!person || person.idpGroups.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-600">
              No groups recorded at last sign-in
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {person.idpGroups.map((group) => (
                <li
                  key={group}
                  className="rounded-full border border-gray-200 px-2.5 py-0.5 font-mono text-xs dark:border-gray-800"
                >
                  {group}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Agents
          </h3>
          {!person || person.agents.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-600">No agents owned</p>
          ) : (
            <ul className="space-y-1">
              {person.agents.map((agent) => (
                <li key={agent.id} className="flex items-center gap-2 text-sm">
                  <Link
                    href={`/${slug}/admin/agents/${agent.id}`}
                    className="min-w-0 truncate text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {agent.name}
                  </Link>
                  {!agent.enabled && <span className="text-xs text-gray-400">(off)</span>}
                  <span className="ml-auto shrink-0 text-xs text-gray-500">
                    {agent.lastRunAt ? (
                      <>
                        ran <LocalTime at={agent.lastRunAt} format="date" />
                      </>
                    ) : (
                      'never run'
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** Keep the address in step with the view so a person's usage can be linked to. */
function syncUrl(periodKey: string, subject: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('period', periodKey);
  if (subject) url.searchParams.set('user', subject);
  else url.searchParams.delete('user');
  window.history.replaceState(window.history.state, '', url);
}

export default function OrgUsageViewer({
  slug,
  tenantId,
  initial,
}: {
  slug: string;
  tenantId: string;
  initial: OrgUsageReport;
}) {
  const [report, setReport] = useState(initial);
  const [series, setSeries] = useState<Series>('tokens');
  const [includeAgents, setIncludeAgents] = useState(initial.includeAgentsInTopUsers);
  const [pending, startTransition] = useTransition();

  function refresh(periodKey: string, nextIncludeAgents: boolean, subject: string | null) {
    startTransition(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const next = await getOrgUsageReport(
        tenantId,
        periodKey,
        timeZone,
        nextIncludeAgents,
        subject
      );
      setReport(next);
      syncUrl(next.periodKey, next.subject);
    });
  }

  if (report.forbidden || report.signedOut) {
    return (
      <div className="mx-auto max-w-lg">
        <h2 className="mb-2 text-lg font-semibold">
          {report.signedOut ? 'Sign in required' : 'Operator access required'}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{report.error}</p>
      </div>
    );
  }

  const { tokens, activity, subject } = report;
  const scoped = subject !== null;
  const personName = report.person?.name ?? subject ?? '';
  const listeners = boardRows(report.topListeners, report.selectedListener);
  const speakers = boardRows(report.topSpeakers, report.selectedSpeaker);
  /** A name on a voice board scopes the page to that person, as the token board's does. */
  const voiceLabel = (row: RankedVoiceUserRow) =>
    row.subject === subject ? (
      row.label
    ) : (
      <button
        type="button"
        disabled={pending}
        onClick={() => refresh(report.periodKey, includeAgents, row.subject)}
        className="truncate text-left text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
      >
        {row.label}
      </button>
    );
  const totalTokens = (['chat', 'chatProjects', 'codeProjects', 'agents'] as const).reduce(
    (sum, key) => sum + tokens[key].input + tokens[key].output,
    0
  );
  const failureRate = activity.runs > 0 ? (activity.failures / activity.runs) * 100 : 0;
  const toolErrorRate =
    activity.toolCalls > 0 ? (activity.toolErrors / activity.toolCalls) * 100 : 0;
  const activePct = activeUserPercent(activity.activeUsers, activity.totalUsers);
  const period = ORG_USAGE_PERIODS.find((candidate) => candidate.key === report.periodKey) ?? {
    key: report.periodKey,
    label: `${report.days} days`,
    days: report.days,
    endOffsetDays: 0,
  };
  const hourly = report.days <= 1;
  const active = activeSummary(report.cells);
  const modelTotal = report.byModel.reduce(
    (sum, row) => sum + row.inputTokens + row.outputTokens,
    0
  );

  // The top few, then — below a gap — the selected person's own row when
  // they rank outside them. Inside the top they are simply highlighted.
  const selected = report.selectedUser;
  const selectedInTop =
    selected !== null && report.topUsers.some((row) => row.rank === selected.rank);
  const userRows: RankedUserRow[] =
    selected !== null && !selectedInTop ? [...report.topUsers, selected] : report.topUsers;
  // An ellipsis only when ranks are actually skipped: #6 straight after #5 needs none.
  const skipsRanks =
    selected !== null && !selectedInTop && selected.rank > report.topUsers.length + 1;
  // The picker knows everyone who signed in; a subject reached by link may
  // not be among them (a grant or agent owner who never did), so it is
  // listed too rather than snapping the picker back to "Everyone".
  const pickerPeople = report.people.some((person) => person.subject === subject)
    ? report.people
    : subject
      ? [{ subject, label: personName }, ...report.people]
      : report.people;

  return (
    <div className="flex flex-col gap-5" data-wide-page>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">Organization usage</h1>
        <Link
          href={`/${slug}/admin`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Organization
        </Link>
        <p className="w-full text-sm text-gray-500 dark:text-gray-400">
          Every surface&rsquo;s and model&rsquo;s token spend across the tenant — chat, chat
          projects, code projects and agents — how much of the org is actually using it, and who and
          what is driving the bill. Pick a person to see the same for them alone, along with their
          groups and agents. Counts only, never content.
        </p>
      </header>

      {report.error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          {report.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav className="flex flex-wrap items-center gap-2" aria-label="Period">
          {ORG_USAGE_PERIODS.map((option) => (
            <button
              key={option.key}
              type="button"
              disabled={pending}
              onClick={() => refresh(option.key, includeAgents, subject)}
              aria-pressed={report.periodKey === option.key}
              className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 ${
                report.periodKey === option.key
                  ? 'border-blue-600 bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
              }`}
            >
              {option.label}
            </button>
          ))}
        </nav>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400">Person</span>
          <select
            value={subject ?? ''}
            disabled={pending}
            onChange={(event) =>
              refresh(report.periodKey, includeAgents, event.target.value || null)
            }
            className="max-w-xs rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950"
          >
            <option value="">Everyone</option>
            {pickerPeople.map((person) => (
              <option key={person.subject} value={person.subject}>
                {person.label}
              </option>
            ))}
          </select>
        </label>
        {pending && <LoadingLine />}
      </div>

      {scoped && <PersonCard slug={slug} subject={subject} person={report.person} />}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Tokens"
          value={formatTokens(totalTokens)}
          hint={`${formatTokens(tokens.agents.input + tokens.agents.output)} in agents`}
        />
        {scoped ? (
          <Stat
            label={hourly ? 'Active hours' : 'Active days'}
            value={`${active.active.toLocaleString('en-US')} / ${active.total.toLocaleString('en-US')}`}
            hint={
              active.active > 0
                ? `${hourly ? 'hours' : 'days'} with a token, a run or a tool call`
                : `nothing in this period`
            }
          />
        ) : (
          <Stat
            label="Active users"
            value={`${activity.activeUsers.toLocaleString('en-US')} / ${activity.totalUsers.toLocaleString('en-US')}`}
            hint={`${activePct}% used at least one token`}
          />
        )}
        <Stat
          label="Agent runs"
          value={activity.runs.toLocaleString('en-US')}
          hint={
            activity.failures > 0
              ? `${activity.failures.toLocaleString('en-US')} failed (${failureRate.toFixed(0)}%)`
              : activity.runs > 0
                ? 'none failed'
                : undefined
          }
        />
        <Stat
          label="Tool calls"
          value={activity.toolCalls.toLocaleString('en-US')}
          hint={
            activity.toolErrors > 0
              ? `${activity.toolErrors.toLocaleString('en-US')} failed (${toolErrorRate.toFixed(1)}%)`
              : activity.toolCalls > 0
                ? 'none failed'
                : undefined
          }
        />
      </section>

      {scoped && (
        <figure className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <figcaption className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">
            {hourly ? `Active hours, ${period.label.toLowerCase()}` : 'Active days'}
          </figcaption>
          <ActivityCalendar cells={report.cells} hourly={hourly} />
        </figure>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <TokenSurfaceBreakdown tokens={tokens} />
        <Leaderboard<ModelTokenRow>
          heading="Tokens by model"
          hint={
            scoped
              ? `Every model call made as ${personName} — chats, agents and optimizer passes alike.`
              : 'Every model call in the organization — chats, agents and optimizer passes alike.'
          }
          rows={report.byModel}
          empty="No model has been called in this period."
          keyOf={(row) => `${row.provider ?? ''}:${row.model ?? ''}`}
          labelOf={(row) => modelLabel(row.provider, row.model)}
          valueOf={(row) => row.inputTokens + row.outputTokens}
          formatValue={(row) => {
            const total = row.inputTokens + row.outputTokens;
            const share = modelTotal > 0 ? Math.round((total / modelTotal) * 100) : 0;
            return `${formatTokens(total)} · ${share}% · ${row.calls.toLocaleString('en-US')} calls`;
          }}
          barClassName="bg-indigo-500"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <VoiceUsageCard
          totals={report.voice}
          hint={
            scoped
              ? `Replies read aloud to ${personName}, and what they said to the chat by voice.`
              : 'Replies read aloud across the organization, and what people said to the chat by voice.'
          }
        />
        <Leaderboard<RankedVoiceUserRow>
          heading="Top listeners"
          hint={
            scoped && report.selectedListener === null
              ? `${personName} had no reply read aloud in this period. By characters of replies read aloud.`
              : 'By characters of replies read aloud. Pick a name to scope the page to that person.'
          }
          rows={listeners.rows}
          empty="Nobody has had a reply read aloud in this period."
          keyOf={(row) => row.subject}
          labelOf={voiceLabel}
          valueOf={(row) => row.speechCharacters}
          formatValue={(row) => `${formatTokens(row.speechCharacters)} chars`}
          rankOf={(row) => row.rank}
          highlightOf={(row) => row.subject === subject}
          gapBefore={(row) => row.rank === listeners.gapAtRank}
          barClassName="bg-rose-500"
        />
        <Leaderboard<RankedVoiceUserRow>
          heading="Top speakers"
          hint={
            scoped && report.selectedSpeaker === null
              ? `${personName} said nothing to the chat by voice in this period. By time spoken.`
              : 'By time spoken to the chat — dictation and voice conversations. Pick a name to scope the page to that person.'
          }
          rows={speakers.rows}
          empty="Nobody has spoken to the chat in this period."
          keyOf={(row) => row.subject}
          labelOf={voiceLabel}
          valueOf={(row) => row.transcriptionMs}
          formatValue={(row) => formatDuration(row.transcriptionMs)}
          rankOf={(row) => row.rank}
          highlightOf={(row) => row.subject === subject}
          gapBefore={(row) => row.rank === speakers.gapAtRank}
          barClassName="bg-emerald-500"
        />
      </div>

      <figure className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <figcaption className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {periodCaption(period)}
          </span>
          <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-700">
            {SERIES.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setSeries(option.key)}
                aria-pressed={series === option.key}
                className={`px-3 py-1 text-xs ${
                  series === option.key
                    ? 'bg-blue-600 font-medium text-white'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'
                }`}
              >
                {option.label}
              </button>
            ))}
          </span>
        </figcaption>
        <Chart points={report.series} series={series} />
      </figure>

      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Top users
            </h2>
            <span className="inline-flex overflow-hidden rounded-lg border border-gray-300 text-xs dark:border-gray-700">
              {(
                [
                  { key: false, label: 'Chats only' },
                  { key: true, label: '+ agents' },
                ] as const
              ).map((option) => (
                <button
                  key={String(option.key)}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setIncludeAgents(option.key);
                    refresh(report.periodKey, option.key, subject);
                  }}
                  aria-pressed={includeAgents === option.key}
                  className={`px-2 py-1 disabled:opacity-50 ${
                    includeAgents === option.key
                      ? 'bg-blue-600 font-medium text-white'
                      : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </span>
          </div>
          <Leaderboard<RankedUserRow>
            heading="By tokens spent"
            hint={
              scoped && selected === null
                ? `${personName} spent no tokens in this period. ${
                    includeAgents
                      ? 'Chat, chat-project, code-project and agent tokens combined.'
                      : 'Chat, chat-project and code-project tokens — toggle above to fold in their agents.'
                  }`
                : includeAgents
                  ? 'Chat, chat-project, code-project and agent tokens combined. Pick a name to scope the page to that person.'
                  : 'Chat, chat-project and code-project tokens — toggle above to fold in their agents. Pick a name to scope the page to that person.'
            }
            rows={userRows}
            empty="Nobody has spent any tokens in this period."
            keyOf={(row) => row.subject}
            labelOf={(row) =>
              row.subject === subject ? (
                row.label
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => refresh(report.periodKey, includeAgents, row.subject)}
                  className="truncate text-left text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                >
                  {row.label}
                </button>
              )
            }
            valueOf={(row) => row.totalTokens}
            formatValue={(row) => formatTokens(row.totalTokens)}
            rankOf={(row) => row.rank}
            highlightOf={(row) => row.subject === subject}
            gapBefore={(row) => skipsRanks && row.rank === selected!.rank}
          />
        </div>

        <Leaderboard<TopAgentRow>
          heading="Top agents"
          hint={
            scoped
              ? `${personName}'s agents by total tokens spent over the period.`
              : 'By total tokens spent over the period.'
          }
          rows={report.topAgents}
          empty="No agent has run in this period."
          keyOf={(row) => row.agentId}
          labelOf={(row) => (
            <Link
              href={`/${slug}/admin/agents/${row.agentId}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {row.name}
            </Link>
          )}
          valueOf={(row) => row.inputTokens + row.outputTokens}
          formatValue={(row) => formatTokens(row.inputTokens + row.outputTokens)}
        />

        <Leaderboard<EfficientAgentRow>
          heading="Most efficient agents"
          hint="Tool calls per 1,000 tokens, among succeeded runs — real work per token, not just cheap runs."
          rows={report.efficientAgents}
          empty="No agent has 3 or more succeeded runs in this period yet."
          keyOf={(row) => row.agentId}
          labelOf={(row) => (
            <Link
              href={`/${slug}/admin/agents/${row.agentId}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {row.name}
            </Link>
          )}
          valueOf={(row) => row.efficiency}
          formatValue={(row) =>
            `${row.efficiency.toFixed(1)} / 1k · ${formatTokens(row.tokensPerRun)}/run`
          }
          barClassName="bg-emerald-500"
        />
      </div>

      <Leaderboard<OrgToolRow>
        heading="Top tools"
        hint={
          scoped
            ? `Most-called tools as ${personName} over the period — from a chat client and by their agents.`
            : 'Most-called tools across the whole organization over the period.'
        }
        rows={report.topTools}
        empty="No tool has been called in this period."
        keyOf={(row) => row.tool}
        labelOf={(row) => row.tool}
        valueOf={(row) => row.calls}
        formatValue={(row) =>
          row.errors > 0
            ? `${row.calls.toLocaleString('en-US')} (${row.errors.toLocaleString('en-US')} failed)`
            : row.calls.toLocaleString('en-US')
        }
      />

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Days are calendar days in {report.timeZone}.{' '}
        {scoped ? (
          <>
            An &ldquo;active&rdquo; {hourly ? 'hour' : 'day'} is one in which {personName} spent a
            token, ran an agent, or called a tool — from a chat client or through an agent acting
            for them.
          </>
        ) : (
          <>
            &ldquo;Active users&rdquo; counts anyone who spent at least one token — in a chat, a
            project, or an agent run — during the period, against everyone who has ever signed in to
            this organization.
          </>
        )}
      </p>
    </div>
  );
}
