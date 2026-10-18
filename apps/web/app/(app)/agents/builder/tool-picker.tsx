'use client';

/**
 * Which tools the agent may use — the agent's whole reach. A tool that is
 * not selected is not something a run can call or propose at all.
 *
 * Every tool says what it does to the world: "reads" tools the agent calls
 * itself while it works; "changes" tools it can only PROPOSE — they are
 * staged and carried out once accepted. Grouped by connector, searchable,
 * selected ones first so the current reach reads at a glance.
 */

import { useMemo, useState } from 'react';
import { MAX_AGENT_TOOLS } from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { friendlyToolName } from '@/lib/tool-name';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

export function ToolPicker({
  tools,
  selected,
  onChange,
  issues,
}: {
  tools: ToolDescriptor[];
  selected: string[];
  onChange: (next: string[]) => void;
  issues: string[];
}) {
  const [filter, setFilter] = useState('');
  const chosen = useMemo(() => new Set(selected), [selected]);
  const offered = useMemo(() => tools.filter((tool) => !tool.appOnly), [tools]);
  const known = useMemo(() => new Set(offered.map((tool) => tool.name)), [offered]);

  const groups = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matches = query
      ? offered.filter(
          (tool) =>
            tool.name.toLowerCase().includes(query) ||
            friendlyToolName(tool.name, tool.title).toLowerCase().includes(query) ||
            (tool.description ?? '').toLowerCase().includes(query) ||
            (tool.connector ?? '').toLowerCase().includes(query)
        )
      : offered;
    const byConnector = new Map<string, ToolDescriptor[]>();
    for (const tool of matches) {
      const key = tool.connector ?? 'other';
      byConnector.set(key, [...(byConnector.get(key) ?? []), tool]);
    }
    return [...byConnector.entries()]
      .map(([connector, list]) => ({
        connector,
        list: [...list].sort(
          (a, b) =>
            Number(chosen.has(b.name)) - Number(chosen.has(a.name)) || a.name.localeCompare(b.name)
        ),
        picked: list.filter((tool) => chosen.has(tool.name)).length,
      }))
      .sort(
        (a, b) =>
          Number(b.picked > 0) - Number(a.picked > 0) || a.connector.localeCompare(b.connector)
      );
  }, [offered, filter, chosen]);

  const toggle = (name: string) => {
    onChange(chosen.has(name) ? selected.filter((tool) => tool !== name) : [...selected, name]);
  };
  // A saved selection naming a tool the owner no longer has: shown so it
  // can be removed, since the save will refuse it.
  const missing = selected.filter((name) => !known.has(name));
  const over = selected.length > MAX_AGENT_TOOLS;

  const toolsAnchor = useCoachAnchor('builder-tools');
  return (
    <section
      {...toolsAnchor}
      aria-label="Tools"
      className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Tools</h2>
        <span
          data-testid="tool-count"
          className={`text-xs ${over ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {selected.length} of at most {MAX_AGENT_TOOLS} selected
        </span>
      </div>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        What the agent may use. It calls tools that <strong>read</strong> on its own; tools that{' '}
        <strong>change</strong> something are only proposed — staged for you (or auto-accept) to
        approve before they run.
      </p>
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Search tools…"
        aria-label="Search tools"
        className="mt-3 w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      {missing.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {missing.map((name) => (
            <li
              key={name}
              className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              <span className="min-w-0 flex-1 truncate">
                {name} — not available to you any more
              </span>
              <button type="button" onClick={() => toggle(name)} className="font-medium underline">
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 max-h-96 space-y-3 overflow-y-auto rounded-md border border-gray-200 p-2 dark:border-gray-800">
        {groups.length === 0 ? (
          <p className="px-1 py-0.5 text-xs text-gray-400">
            {offered.length === 0
              ? 'Connect an account to give your agents tools.'
              : 'No tools match.'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.connector}>
              <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {group.connector}
                {group.picked > 0 ? ` · ${group.picked} selected` : ''}
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {group.list.map((tool) => (
                  <li key={tool.name}>
                    <label
                      className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                      title={tool.description ?? tool.name}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={chosen.has(tool.name)}
                        onChange={() => toggle(tool.name)}
                        aria-label={friendlyToolName(tool.name, tool.title)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {friendlyToolName(tool.name, tool.title)}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-gray-400">
                          {tool.name}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                          tool.kind === 'read'
                            ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                            : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                        }`}
                      >
                        {tool.kind === 'read' ? 'reads' : 'changes — staged'}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
      {issues.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {issues.map((issue) => (
            <li key={issue} role="alert" className="text-xs text-red-600 dark:text-red-400">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
