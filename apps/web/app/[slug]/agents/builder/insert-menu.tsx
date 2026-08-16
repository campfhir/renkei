'use client';

/**
 * The chip editor's autocomplete popover, in two modes that share one
 * keyboard model:
 *
 *  - Browsing (empty query): tools grouped by connector, then details —
 *    the catalog laid out for scanning.
 *  - Searching (any query): one RANKED flat list, best match first, from
 *    the word-order-insensitive scorer in options.ts — typing filters, it
 *    never merely narrows in document order.
 *
 * A search box sits at the top whenever the menu was opened by the button
 * (`withSearchBox`); the slash flow keeps typing inline in the editor and
 * hides the box. Both feed the same `query`.
 *
 * The one-tool rule surfaces here: when the editor already holds its tool
 * chip, the tool section collapses to a hint row instead of options.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  matchesQuery,
  rankOptions,
  type InsertOption,
  type ToolOption,
  type VariableOption,
} from './options';

export interface InsertMenuProps {
  query: string;
  onQueryChange?: (query: string) => void;
  /** Render the search input (button-opened menus; slash flow types inline). */
  withSearchBox: boolean;
  tools: ToolOption[];
  variables: VariableOption[];
  /** Non-null when tools may not be inserted; shown instead of the list. */
  toolsBlockedHint: string | null;
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (option: InsertOption) => void;
  onNavigate: (delta: 1 | -1) => void;
  onCommit: () => void;
  onClose: () => void;
  listboxId: string;
}

/** Filtered tools in their rendered grouping — browsing mode's order. */
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
  if (query) {
    // Searching: ranked flat lists, tools then details.
    const shownTools = toolsBlocked ? [] : rankOptions(tools, query);
    return [...shownTools, ...rankOptions(variables, query)];
  }
  const shownTools = toolsBlocked ? [] : [...groupTools(tools, query).values()].flat();
  return [...shownTools, ...variables];
}

export function optionDomId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

export function InsertMenu({
  query,
  onQueryChange,
  withSearchBox,
  tools,
  variables,
  toolsBlockedHint,
  activeIndex,
  onHover,
  onSelect,
  onNavigate,
  onCommit,
  onClose,
  listboxId,
}: InsertMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (withSearchBox) searchRef.current?.focus();
  }, [withSearchBox]);

  useEffect(() => {
    const active = listRef.current?.querySelector(`#${optionDomId(listboxId, activeIndex)}`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId]);

  const toolsBlocked = toolsBlockedHint !== null;
  const searching = query.length > 0;

  const rankedTools = useMemo(
    () => (toolsBlocked || !searching ? [] : rankOptions(tools, query)),
    [toolsBlocked, searching, tools, query]
  );
  const toolGroups = useMemo(
    () => (toolsBlocked || searching ? new Map<string, ToolOption[]>() : groupTools(tools, query)),
    [toolsBlocked, searching, tools, query]
  );
  const shownVars = useMemo(
    () => (searching ? rankOptions(variables, query) : variables),
    [searching, variables, query]
  );

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
        {searching && option.kind === 'tool' ? (
          <span
            className={`ml-2 text-[0.65rem] uppercase tracking-wide ${
              thisIndex === activeIndex ? 'text-blue-200' : 'text-gray-400'
            }`}
          >
            {option.group}
          </span>
        ) : null}
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

  const toolCount = rankedTools.length + [...toolGroups.values()].flat().length;

  return (
    <div
      ref={menuRef}
      className="absolute z-20 mt-1 w-full min-w-64 rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      {withSearchBox ? (
        <div className="border-b border-gray-100 p-1.5 dark:border-gray-800">
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQueryChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                onNavigate(event.key === 'ArrowDown' ? 1 : -1);
              } else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                onCommit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
            onBlur={(event) => {
              // Option clicks are mousedown-prevented and never blur; a
              // real focus departure from the menu means the user left.
              if (
                !(event.relatedTarget instanceof Node) ||
                !menuRef.current?.contains(event.relatedTarget)
              ) {
                onClose();
              }
            }}
            placeholder="Search skills and details…"
            aria-label="Search skills and details"
            className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-950"
          />
        </div>
      ) : null}

      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Insert a skill or detail"
        className="max-h-72 overflow-y-auto p-1"
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
        ) : searching ? (
          rankedTools.map(row)
        ) : (
          [...toolGroups.entries()].map(([group, groupedTools]) => (
            <div key={group}>
              <div
                role="presentation"
                className="px-2 pb-0.5 pt-1 text-[0.65rem] text-gray-400 dark:text-gray-500"
              >
                {group}
              </div>
              {groupedTools.map(row)}
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
    </div>
  );
}
