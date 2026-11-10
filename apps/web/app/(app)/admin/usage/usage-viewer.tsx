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

import { useReducer, useTransition } from 'react';
import Link from 'next/link';
import { getOrgUsageReport, type OrgUsageReport } from './actions';
import { ORG_USAGE_PERIODS, formatTokens, periodCaption, type RankedUserRow } from './window';
import {
  addressFor,
  blocked,
  init,
  isHourly,
  modelLine,
  periodOf,
  personName as personNameOf,
  pickerPeople as pickerPeopleOf,
  reducer,
  requestFor,
  statTiles,
  topUsersBoard,
  topUsersHint,
  type UsageChange,
} from './usage-viewer.model';
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
import { ImageUsageCard } from '@/components/image-usage-card';
import { Leaderboard } from '@/components/leaderboard';
import { boardRows, formatDuration, type RankedVoiceUserRow } from '@/lib/usage/voice-window';
import {
  boardRows as imageBoardRows,
  formatBytes,
  type RankedImageUserRow,
} from '@/lib/usage/image-window';
import { UsageChart, USAGE_SERIES } from '@/components/usage-chart';
import { ActivityCalendar } from '@/components/activity-calendar';
import LocalTime from '@/components/local-time';
import { LoadingLine } from '@/components/skeleton';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { clientLogger } from '@/lib/client-logger';

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
function PersonCard({ subject, person }: { subject: string; person: PersonProfile | null }) {
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
          <Link href={`/admin/access`} className="text-blue-600 hover:underline dark:text-blue-400">
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
                    href={`/admin/agents/${agent.id}`}
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
function syncUrl(report: OrgUsageReport): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(window.history.state, '', addressFor(window.location.href, report));
}

export default function OrgUsageViewer({ initial }: { initial: OrgUsageReport }) {
  const [state, dispatch] = useReducer(reducer, initial, init);
  const { report, series, includeAgents } = state;
  const [pending, startTransition] = useTransition();
  const periodAnchor = useCoachAnchor('admin-usage-period');
  const personAnchor = useCoachAnchor('admin-usage-person');

  function refresh(change: UsageChange) {
    const request = requestFor(state, change);
    if (change.kind === 'includeAgents') {
      dispatch({ type: 'includeAgentsPicked', includeAgents: change.includeAgents });
    }
    startTransition(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const next = await getOrgUsageReport(
        request.periodKey,
        timeZone,
        request.includeAgents,
        request.subject
      );
      if (next.error && !next.signedOut && !next.forbidden) {
        clientLogger.warn('admin/usage', 'usage report failed', next.error, {
          periodKey: request.periodKey,
        });
      }
      dispatch({ type: 'reportArrived', report: next });
      syncUrl(next);
    });
  }
  const scopeTo = (person: string) => refresh({ kind: 'person', subject: person });

  const stop = blocked(report);
  if (stop) {
    return (
      <div className="mx-auto max-w-lg">
        <h2 className="mb-2 text-lg font-semibold">{stop.heading}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{stop.message}</p>
      </div>
    );
  }

  const { tokens, subject } = report;
  const scoped = subject !== null;
  const personName = personNameOf(report);
  const listeners = boardRows(report.topListeners, report.selectedListener);
  const speakers = boardRows(report.topSpeakers, report.selectedSpeaker);
  const imagers = imageBoardRows(report.topImageUsers, report.selectedImageUser);
  /** A name on the image board scopes the page to that person too. */
  const imageLabel = (row: RankedImageUserRow) =>
    row.subject === subject ? (
      row.label
    ) : (
      <button
        type="button"
        disabled={pending}
        onClick={() => scopeTo(row.subject)}
        className="truncate text-left text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
      >
        {row.label}
      </button>
    );
  /** A name on a voice board scopes the page to that person, as the token board's does. */
  const voiceLabel = (row: RankedVoiceUserRow) =>
    row.subject === subject ? (
      row.label
    ) : (
      <button
        type="button"
        disabled={pending}
        onClick={() => scopeTo(row.subject)}
        className="truncate text-left text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
      >
        {row.label}
      </button>
    );
  const period = periodOf(report);
  const hourly = isHourly(report);
  const usersBoard = topUsersBoard(report);
  const pickerPeople = pickerPeopleOf(report);

  return (
    <div className="flex flex-col gap-5" data-wide-page>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">Organization usage</h1>
        <Link href={`/admin`} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          Organization
        </Link>
        <p className="w-full text-sm text-gray-500 dark:text-gray-400">
          Every surface&rsquo;s and model&rsquo;s token spend across the tenant — chat, chat
          projects, code projects, agents and images — how much of the org is actually using it, and
          who and what is driving the bill. Pick a person to see the same for them alone, along with
          their groups and agents. Counts only, never content.
        </p>
      </header>

      {report.error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          {report.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav {...periodAnchor} className="flex flex-wrap items-center gap-2" aria-label="Period">
          {ORG_USAGE_PERIODS.map((option) => (
            <button
              key={option.key}
              type="button"
              disabled={pending}
              onClick={() => refresh({ kind: 'period', periodKey: option.key })}
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
        <label {...personAnchor} className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400">Person</span>
          <select
            value={subject ?? ''}
            disabled={pending}
            onChange={(event) => refresh({ kind: 'person', subject: event.target.value })}
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

      {scoped && <PersonCard subject={subject} person={report.person} />}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {statTiles(report).map((tile) => (
          <Stat key={tile.label} label={tile.label} value={tile.value} hint={tile.hint} />
        ))}
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
        <TokenSurfaceBreakdown tokens={tokens} documents={report.document} />
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
          formatValue={(row) => modelLine(row, report.byModel)}
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
              ? `${personName} had no reply read aloud in this period. By time listened to replies read aloud.`
              : 'By time listened to replies read aloud. Pick a name to scope the page to that person.'
          }
          rows={listeners.rows}
          empty="Nobody has had a reply read aloud in this period."
          keyOf={(row) => row.subject}
          labelOf={voiceLabel}
          valueOf={(row) => row.speechMs}
          formatValue={(row) => formatDuration(row.speechMs)}
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

      <div className="grid gap-4 lg:grid-cols-3">
        <ImageUsageCard
          totals={report.image}
          hint={
            scoped
              ? `Images drawn for ${personName}: how many, how much space, and what the image model billed.`
              : 'Images drawn across the organization: how many, how much space, and what the image model billed.'
          }
        />
        <div className="lg:col-span-2">
          <Leaderboard<RankedImageUserRow>
            heading="Top image creators"
            hint={
              scoped && report.selectedImageUser === null
                ? `${personName} had no image drawn in this period. By size of the image files.`
                : 'By size of the image files kept. Pick a name to scope the page to that person.'
            }
            rows={imagers.rows}
            empty="Nobody has had an image drawn in this period."
            keyOf={(row) => row.subject}
            labelOf={imageLabel}
            valueOf={(row) => row.bytes}
            formatValue={(row) =>
              `${formatBytes(row.bytes)} · ${row.images.toLocaleString('en-US')} ${row.images === 1 ? 'image' : 'images'}`
            }
            rankOf={(row) => row.rank}
            highlightOf={(row) => row.subject === subject}
            gapBefore={(row) => row.rank === imagers.gapAtRank}
            barClassName="bg-pink-500"
          />
        </div>
      </div>

      <figure className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <figcaption className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {periodCaption(period)}
          </span>
          <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-700">
            {USAGE_SERIES.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => dispatch({ type: 'seriesPicked', series: option.key })}
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
        <UsageChart points={report.series} series={series} />
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
                  onClick={() => refresh({ kind: 'includeAgents', includeAgents: option.key })}
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
            hint={topUsersHint(state)}
            rows={usersBoard.rows}
            empty="Nobody has spent any tokens in this period."
            keyOf={(row) => row.subject}
            labelOf={(row) =>
              row.subject === subject ? (
                row.label
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => scopeTo(row.subject)}
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
            gapBefore={(row) => row.rank === usersBoard.gapAtRank}
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
              href={`/admin/agents/${row.agentId}`}
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
              href={`/admin/agents/${row.agentId}`}
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
