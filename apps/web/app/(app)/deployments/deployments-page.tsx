'use client';

/**
 * The Deployments page: each app (a code project whose pipeline Renkei
 * built) with each environment's running commit and what the last report
 * adds, which apps are a merge away from promoting, the newest deployments
 * and the targets. One column on a phone; the newest deployments and the
 * targets beside the apps on a wide screen. What the page decides is
 * deployments-page.model.ts.
 */

import { useEffect, useReducer, useState } from 'react';
import Link from 'next/link';
import ExternalLink from '@/components/external-link';
import { getJson } from '@/lib/fetch-json';
import {
  initialOverview,
  overviewReducer,
  projectChoices,
  readyToPromote,
  recentItems,
  rows,
  targetLines,
  unbuiltApps,
  type OverviewData,
} from './deployments-page.model';
import { DOT, NOTE, PILL, card } from './tones';

const select =
  'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function DeploymentsPage() {
  const [state, dispatch] = useReducer(overviewReducer, initialOverview);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void getJson<OverviewData>('/api/deployments').then((result) => {
      if (!live) return;
      setNow(Date.now());
      if (result.data) dispatch({ type: 'loaded', data: result.data });
      else dispatch({ type: 'failed', error: result.error ?? 'Deployments could not be read.' });
    });
    return () => {
      live = false;
    };
  }, []);

  const data = state.data;
  const list = rows(state, now);
  const ready = readyToPromote(state);
  const recent = recentItems(state, now);
  const targets = targetLines(state);
  const unbuilt = unbuiltApps(state);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="text-xl font-bold">Deployments</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            What is running where, reported by every code project’s pipelines, on Bitbucket and
            GitHub.
          </p>
        </div>
        {data && data.apps.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
              Project
              <select
                value={state.project ?? ''}
                onChange={(e) => dispatch({ type: 'project', project: e.target.value || null })}
                className={select}
              >
                <option value="">All projects</option>
                {projectChoices(state).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
              Show
              <select
                value={state.show}
                onChange={(e) =>
                  dispatch({
                    type: 'show',
                    show: e.target.value === 'attention' ? 'attention' : 'all',
                  })
                }
                className={select}
              >
                <option value="all">Every environment</option>
                <option value="attention">What needs someone</option>
              </select>
            </label>
          </div>
        ) : null}
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {!data && !state.error ? <p className="text-sm text-gray-500">Reading deployments…</p> : null}

      {data && data.apps.length === 0 ? (
        <section className={card}>
          <h2 className="text-sm font-semibold">Nothing reports here yet</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            A code project’s deployments show here once its pipeline is built from blocks and runs:
            every deploy step tells Renkei how it went.{' '}
            {unbuilt.length > 0 ? (
              'Build one for a project below.'
            ) : (
              <>
                Make a code project in{' '}
                <Link href="/code" className="text-blue-600 hover:underline dark:text-blue-400">
                  Code
                </Link>{' '}
                first.
              </>
            )}
          </p>
        </section>
      ) : null}

      {ready.map((item) => (
        <section
          key={`${item.projectId}-${item.to}`}
          aria-label="Ready to promote"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950"
        >
          <p className="min-w-0 flex-[1_1_18rem] text-sm">
            <span className="font-semibold">Ready to promote. </span>
            {item.text}
          </p>
          <Link
            href={`/deployments/${item.projectId}`}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            Review and promote
          </Link>
        </section>
      ))}

      {data && data.apps.length > 0 ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section aria-label="Apps" className="min-w-0 space-y-3">
            {list.length === 0 ? (
              <p className="text-sm text-gray-500">Nothing needs anyone right now.</p>
            ) : null}
            {list.map((row) => (
              <article
                key={row.projectId}
                aria-label={row.name}
                className={`${card} flex flex-wrap items-start gap-4`}
              >
                <div className="min-w-0 flex-[0_1_12rem]">
                  <Link
                    href={`/deployments/${row.projectId}`}
                    className="font-mono text-sm font-semibold text-blue-700 hover:underline dark:text-blue-400"
                  >
                    {row.name}
                  </Link>
                  <p className="text-xs text-gray-500">{row.detail}</p>
                </div>
                <ul className="flex min-w-0 flex-[1_1_20rem] flex-wrap gap-3">
                  {row.cells.map((cell) => (
                    <li
                      key={cell.name}
                      className="min-w-0 flex-[1_1_12rem] rounded-md bg-gray-50 p-2 dark:bg-gray-900"
                    >
                      <p className="text-xs font-semibold text-gray-600 dark:text-gray-400">
                        {cell.label}
                      </p>
                      <p className="mt-1 flex items-center gap-2 text-sm">
                        <span
                          aria-hidden
                          className={`inline-block size-2 rounded-full ${DOT[cell.tone]}`}
                        />
                        {cell.commit ? (
                          <>
                            <span className="font-mono">{cell.commit}</span>
                            <span className="text-xs text-gray-500">{cell.when}</span>
                          </>
                        ) : (
                          <span className="text-xs text-gray-500">Not deployed yet</span>
                        )}
                      </p>
                      {cell.target ? (
                        <p className="text-xs text-gray-500">
                          target <span className="font-mono">{cell.target}</span>
                        </p>
                      ) : null}
                      {cell.note ? (
                        <p
                          className={`mt-1 inline-block rounded px-1.5 py-0.5 text-xs ${NOTE[cell.note.tone]}`}
                        >
                          {cell.note.text}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>

          <aside className="min-w-0 space-y-4">
            <section aria-labelledby="recent-deployments" className={`${card} space-y-2`}>
              <h2 id="recent-deployments" className="text-sm font-semibold">
                Recent deployments
              </h2>
              {recent.length === 0 ? (
                <p className="text-sm text-gray-500">No pipeline has reported a deploy yet.</p>
              ) : (
                <ul className="space-y-3">
                  {recent.map((item) => (
                    <li key={item.key} className="flex items-start gap-2 text-sm">
                      <span
                        aria-hidden
                        className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${DOT[item.tone]}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="break-words">
                          <span className="font-mono">{item.line}</span> ·{' '}
                          <span className={`rounded px-1 text-xs ${PILL[item.tone]}`}>
                            {item.result}
                          </span>
                        </p>
                        <p className="text-xs break-words text-gray-500">
                          {item.runUrl ? (
                            <ExternalLink href={item.runUrl} className="hover:underline">
                              {item.detail}
                            </ExternalLink>
                          ) : (
                            item.detail
                          )}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-gray-500">{item.when}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="deploy-targets" className={`${card} space-y-2`}>
              <h2 id="deploy-targets" className="text-sm font-semibold">
                Targets
              </h2>
              <p className="text-xs text-gray-500">
                From the organization’s Bitbucket and GitHub runners.
              </p>
              {targets.length === 0 ? (
                <p className="text-sm text-gray-500">No targets yet.</p>
              ) : (
                <ul className="space-y-1">
                  {targets.map((t) => (
                    <li key={t.name} className="flex items-center gap-2 text-sm">
                      <span
                        aria-hidden
                        className={`inline-block size-2 rounded-full ${DOT[t.tone]}`}
                      />
                      <span className="font-mono">{t.name}</span>
                      <span className="ml-auto text-xs text-gray-500">{t.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      ) : null}
      {unbuilt.length > 0 ? (
        <section aria-labelledby="no-pipeline-yet" className={`${card} space-y-2`}>
          <h2 id="no-pipeline-yet" className="text-sm font-semibold">
            Code projects without a pipeline
          </h2>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {unbuilt.map((p) => (
              <li key={p.projectId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 flex-[1_1_14rem]">
                  <span className="font-mono text-sm font-semibold break-all">{p.name}</span>
                  <span className="block text-xs break-all text-gray-500">{p.detail}</span>
                </span>
                <Link
                  href={p.href}
                  className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  Build its pipeline
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
