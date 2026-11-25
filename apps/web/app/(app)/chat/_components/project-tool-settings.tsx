'use client';

/**
 * A project's "Tool permissions" on its page: the tools it lets run
 * without asking in its chats, and the ones it makes ask — each with
 * Reset — and "Set a tool" (pick, Allow or Ask, Save) for its editors.
 * The rules are project-tool-settings.model.ts's.
 */

import { useEffect, useReducer } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull, getJson } from '@/lib/fetch-json';
import {
  initialProjectToolSettingsState,
  projectPickerGroups,
  projectRuleOptions,
  projectSave,
  projectToolRows,
  projectToolSettingsReducer,
} from './project-tool-settings.model';

const GLYPHS = { check: ICONS.check, question: ICONS.question, lock: ICONS.lock } as const;
const TONES = {
  asks: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  allowed: 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300',
} as const;

export default function ProjectToolSettings({
  projectId,
  className,
}: {
  projectId: string;
  className: string;
}) {
  const [state, dispatch] = useReducer(projectToolSettingsReducer, initialProjectToolSettingsState);
  const route = `/api/chat/projects/${projectId}/tool-permissions`;

  useEffect(() => {
    let live = true;
    void getJson<unknown>(route).then((result) => {
      if (!live) return;
      if (result.data) dispatch({ type: 'loaded', answer: result.data });
      else dispatch({ type: 'load-failed' });
    });
    return () => {
      live = false;
    };
  }, [route]);

  async function change(tool: string, rule: 'allow' | 'ask' | 'clear') {
    if (state.busy) return;
    dispatch({ type: 'change-started', tool });
    const result = await sendJsonFull<unknown>(route, 'PUT', { tool, rule });
    if (result.error === null) dispatch({ type: 'change-succeeded', answer: result.data });
    else dispatch({ type: 'change-failed', error: result.error });
  }

  if (!state.lists) return null;
  const rows = projectToolRows(state);
  const save = projectSave(state);
  return (
    <section aria-labelledby="project-tool-settings-heading" className={className}>
      <div className="mb-1 flex items-center gap-2">
        <h2 id="project-tool-settings-heading" className="text-sm font-semibold">
          Tool permissions
        </h2>
        {state.lists.canEdit ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'picker-opened' })}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.plus} className="h-3.5 w-3.5" />
            Set a tool
          </button>
        ) : null}
      </div>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        For this project’s chats. A chat can still block a tool or make it ask; tools your
        organization locks always ask.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Nothing set: tools that act ask, tools that read run.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-900">
          {rows.map((row) => (
            <li key={row.name} className="flex items-center gap-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate" title={row.name}>
                {row.label}
              </span>
              <span
                title={row.tag.meaning}
                className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${TONES[row.tag.tone]}`}
              >
                <Icon path={GLYPHS[row.tag.glyph]} className="h-3.5 w-3.5" />
                {row.tag.text}
              </span>
              {state.lists?.canEdit ? (
                <button
                  type="button"
                  disabled={row.disabled}
                  onClick={() => void change(row.name, 'clear')}
                  aria-label={`Reset ${row.label} (${row.name})`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <Icon path={ICONS.undo} className="h-3.5 w-3.5" />
                  Reset
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {state.error && !state.picker.open ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}

      {state.picker.open ? (
        <Modal
          title="Set a tool for this project"
          onClose={() => dispatch({ type: 'picker-closed' })}
        >
          <div className="flex max-h-[70vh] flex-col gap-3 text-sm">
            <input
              type="search"
              value={state.picker.filter}
              onChange={(event) => dispatch({ type: 'picker-filter', filter: event.target.value })}
              placeholder="Search tools"
              aria-label="Search tools"
              autoComplete="off"
              autoFocus
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <div
              role="radiogroup"
              aria-label="Tool"
              className="min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-200 p-1 dark:border-gray-800"
            >
              {projectPickerGroups(state).map((group) => (
                <div key={group.key}>
                  <p className="px-1.5 pt-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                    {group.label}
                  </p>
                  {group.tools.map((tool) => (
                    <label
                      key={tool.name}
                      className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 ${
                        tool.selected
                          ? 'bg-blue-50 dark:bg-blue-950/50'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-900'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`project-tool-${projectId}`}
                        checked={tool.selected}
                        onChange={() => dispatch({ type: 'picker-select', tool: tool.name })}
                        aria-label={`${tool.label} (${tool.name})`}
                      />
                      <span className="min-w-0 flex-1 truncate" title={tool.name}>
                        {tool.label}
                      </span>
                      {tool.read ? (
                        <span className="shrink-0 rounded bg-gray-100 px-1 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                          reads
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <fieldset className="flex flex-wrap items-center gap-2">
              <legend className="mb-1 w-full text-xs font-medium text-gray-600 dark:text-gray-400">
                In this project’s chats
              </legend>
              {projectRuleOptions(state).length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">Pick a tool first.</p>
              ) : null}
              {projectRuleOptions(state).map((option) => (
                <label
                  key={option.rule}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                    option.chosen
                      ? 'border-blue-400 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
                      : 'border-gray-300 text-gray-700 dark:border-gray-700 dark:text-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name={`project-rule-${projectId}`}
                    className="sr-only"
                    checked={option.chosen}
                    onChange={() => dispatch({ type: 'picker-rule', rule: option.rule })}
                  />
                  <Icon
                    path={option.rule === 'allow' ? ICONS.check : ICONS.question}
                    className={`h-3.5 w-3.5 ${option.rule === 'allow' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            {state.error ? (
              <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                {state.error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
              <button
                type="button"
                onClick={() => dispatch({ type: 'picker-closed' })}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={save.disabled}
                onClick={() => {
                  const tool = state.picker.selected;
                  const rule = state.picker.rule;
                  if (tool && rule) void change(tool, rule);
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {save.label}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
