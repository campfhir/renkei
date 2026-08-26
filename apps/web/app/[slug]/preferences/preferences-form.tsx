'use client';

import { useState } from 'react';
// The PURE half of the package, not its index: the index reaches the
// database, and a client component that pulls it in drags `pg` — and then
// `dns` — into the browser bundle. That split is what prefs.ts is for.
import {
  ACT_CATEGORIES,
  defaultForCategory,
  type NotificationPrefs,
  type ToastCorner,
} from '@renkei/user-prefs/prefs';
import ConnectorIcon from '@/components/connector-icon';

/**
 * What to be told about, and where.
 *
 * The grid is connector × category rather than one switch per tool. "Tell
 * me when something gets created" is a sentence people say; "tell me about
 * jira_add_attachment" is not, and there are well over a hundred act tools.
 * Per-tool control exists as an override, and lives behind a disclosure so
 * it does not compete with the control most people want.
 *
 * The one thing this page MUST say out loud: preferences apply when a
 * notification is written, so switching something on is not retroactive.
 * Without that sentence the first person to flip a switch and find
 * yesterday still empty reads it as a bug.
 */

/** Both corners, typed without an assertion. */
const TOAST_CORNERS: readonly ToastCorner[] = ['bottom-left', 'bottom-right'];

const CATEGORY_LABELS: Record<string, string> = {
  created: 'Created',
  sent: 'Sent',
  updated: 'Changed',
  deleted: 'Deleted',
  scheduled: 'Scheduled',
  other: 'Anything else',
};

export default function PreferencesForm({
  tenantId,
  connectors,
  initial,
}: {
  tenantId: string;
  connectors: { key: string; label: string }[];
  initial: NotificationPrefs;
}) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  function update(next: NotificationPrefs) {
    setPrefs(next);
    setStatus('idle');
  }

  function toggleCell(connector: string, category: string, on: boolean) {
    const forConnector = { ...(prefs.acts[connector] ?? {}) };
    // An explicit choice is stored even when it equals the default: the
    // default can change, and somebody who chose should not be moved.
    forConnector[category] = on;
    update({ ...prefs, acts: { ...prefs.acts, [connector]: forConnector } });
  }

  function cellValue(connector: string, category: string): boolean {
    return prefs.acts[connector]?.[category] ?? defaultForCategory(category);
  }

  function toggleTool(tool: string, on: boolean) {
    update({ ...prefs, tools: { ...prefs.tools, [tool]: on } });
  }

  function removeTool(tool: string) {
    const tools = { ...prefs.tools };
    delete tools[tool];
    update({ ...prefs, tools });
  }

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

  const overrides = Object.entries(prefs.tools);

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
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left dark:border-gray-800">
                <th className="py-2 pr-3 font-medium">Connector</th>
                {ACT_CATEGORIES.map((category) => (
                  <th key={category} className="px-2 py-2 text-center text-xs font-medium">
                    {CATEGORY_LABELS[category] ?? category}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {connectors.map((connector) => (
                <tr key={connector.key} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-2">
                      <ConnectorIcon
                        capabilityKey={connector.key}
                        label={connector.label}
                        size={16}
                      />
                      <span className="truncate">{connector.label}</span>
                    </span>
                  </td>
                  {ACT_CATEGORIES.map((category) => (
                    <td key={category} className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${connector.label}: ${CATEGORY_LABELS[category] ?? category}`}
                        checked={cellValue(connector.key, category)}
                        onChange={(event) =>
                          toggleCell(connector.key, category, event.target.checked)
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          “Anything else” covers actions Renkei has no specific wording for yet. It is off to start
          with, because it is by far the largest group.
        </p>

        <details className="mt-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
          <summary className="cursor-pointer text-sm font-medium">
            Exceptions for particular skills
            {overrides.length > 0 ? (
              <span className="ml-2 font-normal text-gray-500">{overrides.length}</span>
            ) : null}
          </summary>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            An exception wins over the grid above, in either direction.
          </p>
          {overrides.length === 0 ? (
            <p className="mt-2 text-xs italic text-gray-500">
              None. Add one from a notification when you want to hear more, or less, about one
              particular thing.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {overrides.map(([tool, wanted]) => (
                <li key={tool} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={tool}
                    checked={wanted}
                    onChange={(event) => toggleTool(tool, event.target.checked)}
                  />
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">{tool}</code>
                  <button
                    type="button"
                    onClick={() => removeTool(tool)}
                    className="shrink-0 text-xs text-gray-500 hover:underline"
                  >
                    Use the grid
                  </button>
                </li>
              ))}
            </ul>
          )}
        </details>
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
