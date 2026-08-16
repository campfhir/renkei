'use client';

/**
 * The chip editor's autocomplete popover: one listbox, two labeled
 * sections — "Do something" (tools, grouped by connector) and "Insert a
 * detail" (variables). Pure presentation + keyboard state; the editor owns
 * when it opens and what happens on selection.
 *
 * The one-tool rule surfaces here: when the editor already holds its tool
 * chip, the tool section collapses to a hint row instead of options, so
 * the constraint reads as guidance rather than a rejection after the fact.
 */

import { useEffect, useMemo, useRef } from 'react';
import { matchesQuery, type InsertOption, type ToolOption, type VariableOption } from './options';

export interface InsertMenuProps {
  query: string;
  tools: ToolOption[];
  variables: VariableOption[];
  /** Non-null when tools may not be inserted; shown instead of the list. */
  toolsBlockedHint: string | null;
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (option: InsertOption) => void;
  listboxId: string;
}

/** Filtered tools in their rendered grouping — the ONE source of display order. */
function groupTools(tools: ToolOption[], query: string): Map<string, ToolOption[]> {
  const groups = new Map<string, ToolOption[]>();
  for (const tool of tools.filter((entry) => matchesQuery(entry, query))) {
    const group = groups.get(tool.group) ?? [];
    group.push(tool);
    groups.set(tool.group, group);
  }
  return groups;
}

/** The flat, keyboard-navigable option list — MUST match the render order. */
export function flattenOptions(
  tools: ToolOption[],
  variables: VariableOption[],
  toolsBlocked: boolean,
  query: string
): InsertOption[] {
  const shownTools = toolsBlocked ? [] : [...groupTools(tools, query).values()].flat();
  const shownVars = variables.filter((variable) => matchesQuery(variable, query));
  return [...shownTools, ...shownVars];
}

export function optionDomId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

export function InsertMenu({
  query,
  tools,
  variables,
  toolsBlockedHint,
  activeIndex,
  onHover,
  onSelect,
  listboxId,
}: InsertMenuProps) {
  const options = useMemo(
    () => flattenOptions(tools, variables, toolsBlockedHint !== null, query),
    [tools, variables, toolsBlockedHint, query]
  );
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector(`#${optionDomId(listboxId, activeIndex)}`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId]);

  const toolCount = toolsBlockedHint !== null ? 0 : options.filter((o) => o.kind === 'tool').length;

  let index = -1;
  const row = (option: InsertOption) => {
    index += 1;
    const thisIndex = index;
    return (
      <button
        key={`${option.kind}:${option.name}`}
        type="button"
        role="option"
        id={optionDomId(listboxId, thisIndex)}
        aria-selected={thisIndex === activeIndex}
        // mousedown, not click: the editor must keep focus and its caret.
        onMouseDown={(event) => {
          event.preventDefault();
          onSelect(option);
        }}
        onMouseEnter={() => onHover(thisIndex)}
        className={`block w-full rounded px-2 py-1.5 text-left text-sm ${
          thisIndex === activeIndex ? 'bg-blue-600 text-white' : 'text-gray-800 dark:text-gray-200'
        }`}
      >
        <span className="font-medium">{option.label}</span>
        {option.description ? (
          <span
            className={`ml-2 text-xs ${
              thisIndex === activeIndex ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {option.description.length > 80
              ? `${option.description.slice(0, 80)}…`
              : option.description}
          </span>
        ) : null}
      </button>
    );
  };

  const toolGroups =
    toolsBlockedHint === null ? groupTools(tools, query) : new Map<string, ToolOption[]>();
  const shownVars = variables.filter((variable) => matchesQuery(variable, query));

  return (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label="Insert a skill or detail"
      className="absolute z-20 mt-1 max-h-72 w-full min-w-64 overflow-y-auto rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      <div
        role="presentation"
        className="px-2 pb-0.5 pt-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-gray-400"
      >
        Do something
      </div>
      {toolsBlockedHint !== null ? (
        <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
          {toolsBlockedHint}
        </div>
      ) : toolCount === 0 ? (
        <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
          No skills match “{query}”.
        </div>
      ) : (
        [...toolGroups.entries()].map(([group, groupTools]) => (
          <div key={group}>
            <div
              role="presentation"
              className="px-2 pb-0.5 pt-1 text-[0.65rem] text-gray-400 dark:text-gray-500"
            >
              {group}
            </div>
            {groupTools.map(row)}
          </div>
        ))
      )}
      <div
        role="presentation"
        className="border-t border-gray-100 px-2 pb-0.5 pt-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-gray-400 dark:border-gray-800"
      >
        Insert a detail
      </div>
      {shownVars.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
          No details match “{query}”.
        </div>
      ) : (
        shownVars.map(row)
      )}
    </div>
  );
}
