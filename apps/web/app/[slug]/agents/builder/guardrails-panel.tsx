'use client';

/**
 * "Guardrails & context" — the agent's standing instructions and its
 * blocked skills, edited in the builder rail.
 *
 * The document is free-form ON PURPOSE: role, sources of truth and their
 * precedence, content rules, hard rules — whatever the owner writes is
 * injected IN FULL into every model call of every run, never truncated (a
 * clipped "no PHI" rule is worse than none). Length is therefore the
 * owner's own cost decision, and the helper text says so instead of a
 * character counter enforcing taste.
 *
 * Blocked skills are the mechanical arm: Act tools the engine refuses for
 * model-driven calls no matter what a step or corrective guidance asks.
 * Only Act tools are offered — blocking reads would just break lookups
 * without protecting anything.
 */

import { useMemo, useState } from 'react';
import { friendlyToolName } from '@/lib/tool-name';

export interface BlockableTool {
  name: string;
  title: string | null;
  connector: string | null;
}

const textareaClass =
  'mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-900';

export function GuardrailsPanel({
  guardrails,
  onGuardrailsChange,
  blockedTools,
  onBlockedToolsChange,
  actTools,
  issues,
}: {
  guardrails: string;
  onGuardrailsChange: (next: string) => void;
  blockedTools: string[];
  onBlockedToolsChange: (next: string[]) => void;
  actTools: BlockableTool[];
  issues: string[];
}) {
  const [filter, setFilter] = useState('');
  const [pickerOpen, setPickerOpen] = useState(blockedTools.length > 0);

  const blocked = useMemo(() => new Set(blockedTools), [blockedTools]);
  const shown = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matches = query
      ? actTools.filter(
          (tool) =>
            tool.name.toLowerCase().includes(query) ||
            friendlyToolName(tool.name, tool.title).toLowerCase().includes(query)
        )
      : actTools;
    // Blocked entries float to the top so the current policy reads at a
    // glance even when the list is long.
    return [...matches].sort(
      (a, b) => Number(blocked.has(b.name)) - Number(blocked.has(a.name)) ||
        a.name.localeCompare(b.name)
    );
  }, [actTools, filter, blocked]);

  const toggle = (name: string) => {
    onBlockedToolsChange(
      blocked.has(name) ? blockedTools.filter((tool) => tool !== name) : [...blockedTools, name]
    );
  };

  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h2 className="text-sm font-semibold">Guardrails &amp; context</h2>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        Standing instructions every step follows — a role, sources of truth and their precedence,
        content rules, hard rules. Sent with every model call in full, so the agent never acts
        without them; longer documents cost more per step.
      </p>
      <textarea
        value={guardrails}
        onChange={(event) => onGuardrailsChange(event.target.value)}
        rows={10}
        placeholder={
          'e.g.\n## Role\nYou draft the weekly status report…\n\n## Rules\n- Draft only — never send anything without approval.\n- Never fabricate numbers; write "(not set)" instead.'
        }
        aria-label="Guardrails and context"
        className={textareaClass}
      />

      <div className="mt-3">
        <button
          type="button"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((current) => !current)}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {pickerOpen ? 'Hide blocked skills' : `Block skills… ${blockedTools.length > 0 ? `(${blockedTools.length} blocked)` : ''}`}
        </button>
        {pickerOpen ? (
          <div className="mt-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Skills the agent may NEVER use, whatever a step asks — enforced by the runner, not
              just the wording. Endings you configured (failure emails, WebEx notes) still send.
            </p>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter skills…"
              aria-label="Filter blockable skills"
              className="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-gray-200 p-2 dark:border-gray-800">
              {shown.length === 0 ? (
                <li className="px-1 py-0.5 text-xs text-gray-400">No skills match.</li>
              ) : (
                shown.map((tool) => (
                  <li key={tool.name}>
                    <label
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                      title={tool.name}
                    >
                      <input
                        type="checkbox"
                        checked={blocked.has(tool.name)}
                        onChange={() => toggle(tool.name)}
                      />
                      <span className="min-w-0 truncate">
                        {friendlyToolName(tool.name, tool.title)}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] uppercase text-gray-400">
                        {tool.connector ?? ''}
                      </span>
                    </label>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}
      </div>

      {issues.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {issues.map((issue) => (
            <li key={issue} className="text-xs text-red-600 dark:text-red-400">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
