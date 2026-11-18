'use client';

/**
 * One app's deployments: a card per environment, each promotion — the
 * commits merging brings, the pull request and its checks, and opening or
 * merging it with the person's own grant (a merge is asked twice: the
 * pipeline on the next branch deploys) — and the history. What the page
 * decides is deployment-app.model.ts.
 */

import { useCallback, useEffect, useReducer, useState } from 'react';
import Link from 'next/link';
import BackLink from '@/components/back-link';
import ExternalLink from '@/components/external-link';
import LocalTime from '@/components/local-time';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { HOST_LABEL } from '../deployments-page.model';
import { DOT, NOTE, PILL, card } from '../tones';
import {
  appReducer,
  environmentCards,
  historyRows,
  initialApp,
  mergeQuestion,
  mergeRequest,
  promoteRequest,
  promotions,
  type AppData,
} from './deployment-app.model';

const primary =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const secondary =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';

export default function DeploymentApp({ projectId }: { projectId: string }) {
  const [state, dispatch] = useReducer(appReducer, initialApp);
  const [now, setNow] = useState(() => Date.now());
  const url = `/api/deployments/${projectId}`;

  const load = useCallback(
    async (notice?: string, live: () => boolean = () => true) => {
      const result = await getJson<AppData>(url);
      if (!live()) return;
      setNow(Date.now());
      if (result.data)
        dispatch({ type: 'loaded', data: result.data, ...(notice ? { notice } : {}) });
      else
        dispatch({ type: 'failed', error: result.error ?? 'The deployments could not be read.' });
    },
    [url]
  );
  useEffect(() => {
    let live = true;
    void load(undefined, () => live);
    return () => {
      live = false;
    };
  }, [load]);

  const promote = async (from: string, to: string) => {
    dispatch({ type: 'sent', busy: 'promote' });
    const result = await sendJsonFull<{ number?: number }>(
      `${url}/promote`,
      'POST',
      promoteRequest(from, to)
    );
    if (result.error) return dispatch({ type: 'failed', error: result.error });
    await load(`Pull request #${result.data?.number ?? ''} opened. Merging it deploys.`);
  };

  const merge = async () => {
    const body = mergeRequest(state);
    if (!body) return;
    dispatch({ type: 'sent', busy: 'merge' });
    const result = await sendJsonFull(`${url}/merge`, 'POST', body);
    if (result.error) return dispatch({ type: 'failed', error: result.error });
    const p = state.data?.promotions.find((x) => x.from === body.from && x.to === body.to);
    await load(
      `Merged #${body.number}. The pipeline on ${p?.toBranch ?? 'the branch'} deploys ${body.to} and reports here when it has.`
    );
  };

  const app = state.data;
  const question = mergeQuestion(state);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <BackLink href="/deployments" label="Deployments" />
      {!app && state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {!app && !state.error ? <p className="text-sm text-gray-500">Reading deployments…</p> : null}
      {app ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="font-mono text-xl font-bold">{app.name}</h1>
            {app.stack ? (
              <span className={`rounded px-1.5 text-xs ${PILL.none}`}>{app.stack}</span>
            ) : null}
            <span className="text-sm text-gray-500">
              {HOST_LABEL[app.host]} · <span className="font-mono">{app.repo}</span>
            </span>
            <Link
              href={`/code/${app.projectId}/pipeline-builder`}
              className="text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              Open the code project’s pipeline
            </Link>
          </div>

          {state.notice ? (
            <p
              role="status"
              className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
            >
              {state.notice}
            </p>
          ) : null}
          {state.error ? (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
            >
              {state.error}
            </p>
          ) : null}

          <section aria-label="Environments" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {environmentCards(state, now).map((env) => (
              <article key={env.name} aria-label={env.label} className={`${card} space-y-1`}>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">{env.label}</h2>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${PILL[env.tone]}`}
                  >
                    {env.state}
                  </span>
                </div>
                {env.commit ? (
                  <p className="text-sm">
                    <span className="font-mono">{env.commit}</span>{' '}
                    <span className="text-xs text-gray-500">{env.when}</span>
                    {env.runUrl ? (
                      <>
                        {' '}
                        <ExternalLink
                          href={env.runUrl}
                          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          the run
                        </ExternalLink>
                      </>
                    ) : null}
                  </p>
                ) : null}
                <p className="text-xs text-gray-500">{env.how}</p>
                {env.note ? (
                  <p
                    className={`inline-block rounded px-1.5 py-0.5 text-xs ${NOTE[env.note.tone]}`}
                  >
                    {env.note.text}
                  </p>
                ) : null}
              </article>
            ))}
          </section>

          {promotions(state, now).map((p) => (
            <section key={p.key} aria-label={p.title} className={`${card} space-y-3`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-sm font-semibold">{p.title}</h2>
                {p.pullRequest ? (
                  <ExternalLink
                    href={p.pullRequest.url}
                    className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {p.pullRequest.label}
                  </ExternalLink>
                ) : null}
              </div>
              <p className="text-sm">{p.summary}</p>
              {p.error ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">{p.error}</p>
              ) : null}
              {p.commits.length > 0 ? (
                <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 text-sm dark:divide-gray-800 dark:border-gray-800">
                  {p.commits.map((c) => (
                    <li key={c.sha} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
                      <span className="font-mono text-xs text-gray-500">{c.sha}</span>
                      <span className="min-w-0 flex-1 break-words">{c.message}</span>
                      <span className="text-xs text-gray-500">{c.author}</span>
                    </li>
                  ))}
                  {p.moreCommits ? (
                    <li className="px-3 py-1.5 text-xs text-gray-500">and more</li>
                  ) : null}
                </ul>
              ) : null}
              {p.checks ? (
                <p className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className={`inline-block size-2 rounded-full ${DOT[p.checks.tone]}`}
                  />
                  {p.checks.text}
                </p>
              ) : null}
              <p className="text-xs text-gray-500">
                Renkei merges with your own {HOST_LABEL[app.host]} grant, under the repository’s
                branch rules. It deploys nothing itself: the pipeline on the branch it merges into
                deploys, and its last step reports here.
              </p>
              {question && state.confirming?.from === p.from && state.confirming.to === p.to ? (
                <div
                  role="alertdialog"
                  aria-label="Merge to deploy"
                  className="space-y-2 rounded-md bg-amber-50 p-3 dark:bg-amber-950"
                >
                  <p className="text-sm">{question}</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={state.busy !== null}
                      onClick={() => void merge()}
                      className={primary}
                    >
                      {state.busy === 'merge' ? 'Merging…' : 'Merge and deploy'}
                    </button>
                    <button
                      type="button"
                      onClick={() => dispatch({ type: 'cancelMerge' })}
                      className={secondary}
                    >
                      Not now
                    </button>
                  </div>
                </div>
              ) : p.action.kind === 'merge' ? (
                <button
                  type="button"
                  disabled={state.busy !== null}
                  onClick={() => {
                    if (p.action.kind === 'merge')
                      dispatch({
                        type: 'askMerge',
                        from: p.from,
                        to: p.to,
                        number: p.action.number,
                      });
                  }}
                  className={primary}
                >
                  {p.action.label}
                </button>
              ) : p.action.kind === 'open' ? (
                <button
                  type="button"
                  disabled={state.busy !== null}
                  onClick={() => void promote(p.from, p.to)}
                  className={primary}
                >
                  {state.busy === 'promote' ? 'Opening…' : p.action.label}
                </button>
              ) : (
                <p className="text-xs text-gray-500">{p.action.why}</p>
              )}
            </section>
          ))}

          <section aria-labelledby="deploy-history" className={`${card} space-y-2`}>
            <h2 id="deploy-history" className="text-sm font-semibold">
              History
            </h2>
            {historyRows(state).length === 0 ? (
              <p className="text-sm text-gray-500">
                No deploy has reported yet. The first run of the pipeline will.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 text-sm dark:divide-gray-800">
                {historyRows(state).map((row) => (
                  <li key={row.key} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                    <LocalTime at={row.at} className="w-36 shrink-0 text-xs text-gray-500" />
                    <span className="w-24 shrink-0 font-medium">{row.environment}</span>
                    <span className="font-mono text-xs">{row.commit}</span>
                    <span className={`rounded px-1.5 text-xs ${PILL[row.tone]}`}>{row.result}</span>
                    <span className="text-xs text-gray-500">
                      {row.runUrl ? (
                        <ExternalLink href={row.runUrl} className="hover:underline">
                          {row.run}
                        </ExternalLink>
                      ) : (
                        row.run
                      )}
                    </span>
                    <span className="min-w-0 flex-1 text-xs break-words text-gray-500">
                      {row.by}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
