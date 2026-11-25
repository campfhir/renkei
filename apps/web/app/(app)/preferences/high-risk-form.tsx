'use client';

/**
 * A high-risk list: Preferences › Agents, Preferences › Code projects, and
 * the organization's locked list on admin Settings. One fold per connector
 * (shut by default; its line says how many are on), a filter, a switch per
 * tool. On a person's list the organization's locked tools are switched on
 * and cannot be switched off. Nothing is saved until Save. The rules are
 * high-risk-form.model.ts's, tested beside it.
 */

import { useReducer } from 'react';
import ConnectorIcon from '@/components/connector-icon';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull } from '@/lib/fetch-json';
import { CHAT_OWN_TOOLS_KEY, CODE_TOOLS_KEY, type ActToolGroup } from '@/lib/chat/permission-rules';
import type { HighRiskPrefs } from '@renkei/user-prefs/prefs';
import {
  canSave,
  canUseDefault,
  groupSummary,
  highRiskFormReducer,
  initHighRiskForm,
  isLocked,
  isOn,
  saveBody,
  totalOn,
  unlistedNames,
  visibleGroups,
  type HighRiskListKind,
} from './high-risk-form.model';

const COPY: Record<
  HighRiskListKind,
  { title: string; lead: string; applies: string; switchLabel: string; reset: string }
> = {
  agents: {
    title: 'High-risk actions',
    lead: 'When an agent of yours accepts its own actions, everything it stages runs without waiting for you, except the tools that are high risk here. A batch with a high-risk tool in it waits for you to accept it. Agents that don’t accept their own actions always wait.',
    applies: 'Applies to the next batch any agent of yours stages.',
    switchLabel: 'High risk',
    reset: 'Clear my changes',
  },
  code: {
    title: 'High risk in Auto mode',
    lead: 'With Auto on, a code chat runs its tools without asking, except the ones that are high risk here: those still stop and ask. Out of the box that is everything but the checkout’s own work (editing, committing, pushing, pulling, running), the sandbox and the chat’s own files. Outside Auto mode, Tool permissions decides as before.',
    applies: 'Applies from the next message you send in a code chat.',
    switchLabel: 'High risk',
    reset: 'Use the default',
  },
  org: {
    title: 'Locked high-risk tools',
    lead: 'High risk for everyone, whatever their own lists say: an agent batch holding one always waits for a person, a code project’s Auto mode still asks before one, and no chat can be told to always allow it or allow it for the whole chat. People see these switched on and cannot switch them off.',
    applies: 'Applies to everyone from their next turn or staged batch.',
    switchLabel: 'Locked',
    reset: 'Undo changes',
  },
};

export default function HighRiskForm({
  kind,
  groups,
  locked,
  initial,
}: {
  kind: HighRiskListKind;
  groups: ActToolGroup[];
  locked: string[];
  initial?: HighRiskPrefs;
}) {
  const [state, dispatch] = useReducer(
    highRiskFormReducer,
    { kind, locked, prefs: initial },
    initHighRiskForm
  );
  const copy = COPY[kind];
  const shown = visibleGroups(state, groups);
  const unlisted = unlistedNames(state, groups);
  const filtering = state.filter.trim() !== '';
  const headingId = `high-risk-heading-${kind}`;

  async function save() {
    dispatch({ type: 'save-started' });
    const url = kind === 'org' ? '/api/admin/high-risk-tools' : '/api/preferences/high-risk';
    const result = await sendJsonFull(url, 'PUT', saveBody(state));
    if (result.error === null) dispatch({ type: 'save-succeeded', stored: result.data });
    else dispatch({ type: 'save-failed' });
  }

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="p-4 pb-3">
        <h3 id={headingId} className="font-semibold">
          {copy.title}
        </h3>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">{copy.lead}</p>
        {kind !== 'org' && state.locked.length > 0 ? (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            <Icon path={ICONS.lock} className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              Your organization locks {state.locked.length} tool
              {state.locked.length === 1 ? '' : 's'} as high risk. They stay on here whatever you
              choose.
            </span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 px-4 py-3 dark:border-gray-800">
        <input
          type="search"
          value={state.filter}
          onChange={(event) => dispatch({ type: 'filter', text: event.target.value })}
          placeholder="Filter tools"
          aria-label="Filter tools"
          className="h-8 min-w-0 flex-1 basis-48 rounded-lg border border-gray-300 bg-white px-2.5 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <span className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
          <span className="font-semibold text-amber-700 dark:text-amber-400">
            {totalOn(state, groups)}
          </span>{' '}
          {kind === 'org' ? 'locked' : 'high risk'}
        </span>
        <button
          type="button"
          onClick={() => dispatch({ type: 'use-default' })}
          disabled={!canUseDefault(state)}
          className="text-sm text-blue-600 hover:underline disabled:cursor-default disabled:text-gray-400 disabled:no-underline dark:text-blue-400 dark:disabled:text-gray-600"
        >
          {copy.reset}
        </button>
      </div>

      <div className="space-y-1.5 border-t border-gray-200 px-4 py-3 dark:border-gray-800">
        {shown.length === 0 ? (
          <p className="px-1 py-2 text-sm text-gray-500 dark:text-gray-400">
            {filtering ? `No tool matches “${state.filter}”.` : 'No act tools are offered to you.'}
          </p>
        ) : null}
        {shown.map((group) => (
          <details
            key={group.key}
            open={filtering || undefined}
            className="rounded-lg border border-gray-200 dark:border-gray-800"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm">
              {group.key === CHAT_OWN_TOOLS_KEY ? (
                <Icon path={ICONS.chat} className="h-4 w-4 shrink-0 text-gray-500" />
              ) : group.key === CODE_TOOLS_KEY ? (
                <Icon path={ICONS.code} className="h-4 w-4 shrink-0 text-gray-500" />
              ) : (
                <ConnectorIcon capabilityKey={group.key} label={group.label} size={16} />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
              <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                {groupSummary(state, group)}
              </span>
              <span aria-hidden="true" className="shrink-0 text-gray-400">
                ▾
              </span>
            </summary>
            <div className="border-t border-gray-200 dark:border-gray-800">
              <div className="flex flex-wrap items-center gap-3 px-3 pt-3 text-xs">
                <span className="text-gray-500 dark:text-gray-400">All of {group.label}:</span>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'set-all', group, on: true })}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  {copy.switchLabel}
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'set-all', group, on: false })}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Not {copy.switchLabel.toLowerCase()}
                </button>
              </div>
              <ul className="mt-2">
                {group.tools.map((tool) => {
                  const on = isOn(state, tool.name);
                  const held = isLocked(state, tool.name);
                  return (
                    <li
                      key={tool.name}
                      className={`flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-gray-100 px-3 py-2 text-sm dark:border-gray-900 ${
                        on ? 'bg-amber-50/70 dark:bg-amber-950/20' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{tool.label}</span>
                        <code className="ml-2 font-mono text-xs break-all text-gray-500 dark:text-gray-400">
                          {tool.name}
                        </code>
                      </span>
                      <label
                        className={`flex shrink-0 items-center gap-1.5 text-xs ${
                          on
                            ? 'font-semibold text-amber-700 dark:text-amber-400'
                            : 'text-gray-600 dark:text-gray-400'
                        }`}
                        title={held ? 'Locked by your organization' : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={held}
                          // The wire name is part of the accessible name: two
                          // tools can share a title within a connector.
                          aria-label={`${tool.label} (${tool.name}) — ${copy.switchLabel.toLowerCase()}`}
                          onChange={(event) =>
                            dispatch({ type: 'set', name: tool.name, on: event.target.checked })
                          }
                        />
                        {held ? (
                          <>
                            <Icon path={ICONS.lock} className="h-3 w-3" />
                            Locked
                          </>
                        ) : (
                          copy.switchLabel
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          </details>
        ))}
        {unlisted.length > 0 ? (
          <p className="px-1 pt-1 text-xs text-gray-500 dark:text-gray-400">
            Also {kind === 'org' ? 'locked' : 'high risk'}, for tools not offered to you right now:{' '}
            {unlisted.map((name, index) => (
              <span key={name}>
                {index > 0 ? ', ' : ''}
                <code className="font-mono">{name}</code>
                {kind === 'org' || !state.locked.includes(name) ? (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'set', name, on: false })}
                    className="ml-1 text-blue-600 hover:underline dark:text-blue-400"
                  >
                    remove
                  </button>
                ) : null}
              </span>
            ))}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 px-4 py-3 dark:border-gray-800">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave(state)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {state.status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {state.status === 'saved' ? (
          <span className="text-sm text-green-700 dark:text-green-400">Saved.</span>
        ) : null}
        {state.status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400" role="alert">
            Could not save.
          </span>
        ) : null}
        <p className="text-xs text-gray-500 dark:text-gray-400">{copy.applies}</p>
      </div>
    </section>
  );
}
