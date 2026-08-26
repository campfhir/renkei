'use client';

import { useState } from 'react';
// The PURE half of the package, not its index: the index reaches the
// database, and a client component that pulls it in drags `pg` — and then
// `dns` — into the browser bundle. That split is what prefs.ts is for.
import { wantsAct, type NotificationPrefs, type ToastCorner } from '@renkei/user-prefs/prefs';
import ConnectorIcon from '@/components/connector-icon';

/**
 * What to be told about, and where.
 *
 * ## Why this is a list per connector and not a grid
 *
 * The first version was connector × category — Jira across, "Created /
 * Sent / Changed / Deleted / Scheduled" down. It looked tidy and it could
 * not be read: the Jira row offered a checkbox for "Scheduled", and there
 * is no such thing as scheduling in Jira. Most of the cells were like
 * that. A grid asserts that every connector does every kind of thing, and
 * connectors do not; each one does its own specific handful.
 *
 * So each connector lists the acts it can actually perform, in the words
 * of the act — "Commented on an issue", "Accepted or declined an
 * invitation". That is a list somebody can go down and answer. Categories
 * did not disappear; they order the list and supply the default for a row
 * nobody has touched, which is what they were always good for.
 *
 * ## What is stored
 *
 * A curated row writes `prefs.tools[tool]`, which is the most specific
 * layer of `wantsAct` and therefore wins outright. The "anything else"
 * row per connector writes `prefs.acts[connector].other`, the middle
 * layer, covering every act with no wording yet — a hundred-odd of them,
 * which is why it starts off.
 *
 * Nothing about the stored shape changed when the grid did. A grid entry
 * saved by the old page still applies underneath, so nobody's earlier
 * choices were silently discarded by a redesign of the page that made
 * them.
 *
 * ## The one thing this page MUST say out loud
 *
 * Preferences apply when a notification is WRITTEN, so switching
 * something on is not retroactive. Without that sentence the first person
 * to flip a switch and find yesterday still empty reads it as a bug.
 */

/** Both corners, typed without an assertion. */
const TOAST_CORNERS: readonly ToastCorner[] = ['bottom-left', 'bottom-right'];

interface ConnectorRow {
  key: string;
  label: string;
  acts: { tool: string; short: string; category: string }[];
}

export default function PreferencesForm({
  tenantId,
  connectors,
  initial,
}: {
  tenantId: string;
  connectors: ConnectorRow[];
  initial: NotificationPrefs;
}) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  function update(next: NotificationPrefs) {
    setPrefs(next);
    setStatus('idle');
  }

  /** One act. An explicit choice is stored even when it matches the
   *  default: the default can change, and somebody who chose should not be
   *  quietly moved when it does. */
  function setTool(tool: string, on: boolean) {
    update({ ...prefs, tools: { ...prefs.tools, [tool]: on } });
  }

  /** The per-connector catch-all, which is the 'other' category. */
  function setCatchAll(connector: string, on: boolean) {
    const forConnector = { ...(prefs.acts[connector] ?? {}), other: on };
    update({ ...prefs, acts: { ...prefs.acts, [connector]: forConnector } });
  }

  function setWholeConnector(row: ConnectorRow, on: boolean) {
    const tools = { ...prefs.tools };
    for (const act of row.acts) tools[act.tool] = on;
    update({ ...prefs, tools });
  }

  const wanted = (connector: string, category: string, tool: string | null) =>
    wantsAct(prefs, connector, category, tool);

  /** Curated rows only — the catch-all is counted separately because it
   *  stands for a hundred tools, not one. */
  const countOn = (row: ConnectorRow) =>
    row.acts.filter((act) => wanted(row.key, act.category, act.tool)).length;

  /** Tool switches for tools this build no longer has wording for — an
   *  older page's saves, or a tool that was renamed. Shown only when there
   *  are some, so nobody's choice is stranded invisibly. */
  const known = new Set(connectors.flatMap((row) => row.acts.map((act) => act.tool)));
  const strays = Object.entries(prefs.tools).filter(([tool]) => !known.has(tool));

  async function save() {
    setStatus('saving');
    try {
      const response = await fetch(`/api/tenant/${tenantId}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: prefs }),
      });
      setStatus(response.ok ? 'saved' : 'failed');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <h2 className="font-semibold">Runs</h2>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
          When an agent of yours starts and stops.
        </p>
        <div className="mt-3 space-y-2">
          {(
            [
              ['runStarted', 'A run starts', 'Frequent, and rarely the interesting part.'],
              ['runFinished', 'A run finishes', null],
              ['runFailed', 'A run fails', null],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={prefs[key]}
                onChange={(event) => update({ ...prefs, [key]: event.target.checked })}
              />
              <span>
                {label}
                {hint ? (
                  <span className="block text-xs text-gray-500 dark:text-gray-400">{hint}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <h2 className="font-semibold">Things your agents do</h2>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
          Only actions that change something are ever offered here — reading is never announced.
          Open a connector to choose which of its actions you hear about.
        </p>

        <div className="mt-3 space-y-1.5">
          {connectors.map((row) => {
            const on = countOn(row);
            const catchAll = wanted(row.key, 'other', null);
            return (
              <details
                key={row.key}
                className="rounded-lg border border-gray-200 dark:border-gray-800"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm">
                  <ConnectorIcon capabilityKey={row.key} label={row.label} size={16} />
                  <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
                  <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                    {on} of {row.acts.length}
                    {catchAll ? ', plus anything else' : ''}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-gray-400">
                    ▾
                  </span>
                </summary>

                <div className="border-t border-gray-200 p-3 dark:border-gray-800">
                  <div className="mb-2 flex items-center gap-3 text-xs">
                    <button
                      type="button"
                      onClick={() => setWholeConnector(row, true)}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setWholeConnector(row, false)}
                      className="text-gray-500 hover:underline"
                    >
                      Select none
                    </button>
                  </div>

                  <ul className="space-y-1">
                    {row.acts.map((act) => (
                      <li key={act.tool}>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="shrink-0"
                            checked={wanted(row.key, act.category, act.tool)}
                            onChange={(event) => setTool(act.tool, event.target.checked)}
                          />
                          <span className="min-w-0">{act.short}</span>
                        </label>
                      </li>
                    ))}
                  </ul>

                  {/* Visually separated because it is not one more act: it
                      stands for every act in this connector that Renkei has
                      no wording for yet, which is most of them by count. */}
                  <label className="mt-2 flex items-start gap-2 border-t border-gray-100 pt-2 text-sm dark:border-gray-900">
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0"
                      checked={catchAll}
                      onChange={(event) => setCatchAll(row.key, event.target.checked)}
                    />
                    <span>
                      Anything else in {row.label}
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        Actions with no specific wording yet. Off to start with — it is by far the
                        largest group, and it reads as “Ran jira add attachment”.
                      </span>
                    </span>
                  </label>
                </div>
              </details>
            );
          })}
        </div>

        {strays.length > 0 ? (
          <details className="mt-3 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-700">
            <summary className="cursor-pointer text-sm font-medium">
              Choices for actions this version no longer lists
              <span className="ml-2 font-normal text-gray-500">{strays.length}</span>
            </summary>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Saved against a tool that has since been renamed or removed. They still apply if it
              comes back; clearing one hands it to the settings above.
            </p>
            <ul className="mt-2 space-y-1">
              {strays.map(([tool, on]) => (
                <li key={tool} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={tool}
                    checked={on}
                    onChange={(event) => setTool(tool, event.target.checked)}
                  />
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">{tool}</code>
                  <button
                    type="button"
                    onClick={() => {
                      const tools = { ...prefs.tools };
                      delete tools[tool];
                      update({ ...prefs, tools });
                    }}
                    className="shrink-0 text-xs text-gray-500 hover:underline"
                  >
                    Clear
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <h2 className="font-semibold">Pop-ups</h2>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
          The cards that appear in a corner while you are using Renkei. Turning them off does not
          affect the notifications page.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={prefs.toastsEnabled}
            onChange={(event) => update({ ...prefs, toastsEnabled: event.target.checked })}
          />
          Show pop-ups
        </label>
        <fieldset className="mt-3" disabled={!prefs.toastsEnabled}>
          <legend className="text-sm font-medium">Corner</legend>
          <div className="mt-1 flex gap-4">
            {TOAST_CORNERS.map((corner) => (
              <label key={corner} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="toastCorner"
                  checked={prefs.toastCorner === corner}
                  onChange={() => update({ ...prefs, toastCorner: corner })}
                />
                {corner === 'bottom-left' ? 'Bottom left' : 'Bottom right'}
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving'}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          These apply from now on. Switching something on does not fill in what already happened.
        </p>
      </div>
    </div>
  );
}
