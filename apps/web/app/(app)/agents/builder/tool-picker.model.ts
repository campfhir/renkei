/**
 * What the builder's tool picker (tool-picker.tsx) shows and what a click
 * does to the selection: which tools are offered, how a search narrows
 * them, how they group and order, what the count says, and which selected
 * tools are no longer the owner's to give. Pure functions of the props and
 * the search box; tested in tool-picker.model.test.ts.
 */

import { MAX_AGENT_TOOLS } from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { friendlyToolName } from '@/lib/tool-name';

export interface ToolGroup {
  connector: string;
  list: ToolDescriptor[];
  /** How many of this group's (matching) tools are selected. */
  picked: number;
}

/** The tools an agent may be given: a card's preview twin and app-only tools are not. */
export function offeredTools(tools: ToolDescriptor[]): ToolDescriptor[] {
  return tools.filter((tool) => !tool.appOnly && !tool.previewOf);
}

function matches(tool: ToolDescriptor, query: string): boolean {
  return (
    tool.name.toLowerCase().includes(query) ||
    friendlyToolName(tool.name, tool.title).toLowerCase().includes(query) ||
    (tool.description ?? '').toLowerCase().includes(query) ||
    (tool.connector ?? '').toLowerCase().includes(query)
  );
}

/**
 * The offered tools matching the search, grouped by connector: groups with
 * a selected tool first, then by name; within a group, selected tools
 * first, then by name — so the current reach reads at a glance.
 */
export function toolGroups(
  offered: ToolDescriptor[],
  filter: string,
  selected: readonly string[]
): ToolGroup[] {
  const chosen = new Set(selected);
  const query = filter.trim().toLowerCase();
  const found = query ? offered.filter((tool) => matches(tool, query)) : offered;
  const byConnector = new Map<string, ToolDescriptor[]>();
  for (const tool of found) {
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
}

/** A click on a tool: off if it was on, else added at the end. */
export function toggledTools(selected: readonly string[], name: string): string[] {
  return selected.includes(name) ? selected.filter((tool) => tool !== name) : [...selected, name];
}

/**
 * Selected tools the owner no longer has: shown so they can be removed,
 * since the save will refuse them.
 */
export function missingTools(selected: readonly string[], offered: ToolDescriptor[]): string[] {
  const known = new Set(offered.map((tool) => tool.name));
  return selected.filter((name) => !known.has(name));
}

/** The count beside the heading, and whether it is past the limit (drawn in red). */
export function toolCount(selected: readonly string[]): { text: string; over: boolean } {
  return {
    text: `${selected.length} of at most ${MAX_AGENT_TOOLS} selected`,
    over: selected.length > MAX_AGENT_TOOLS,
  };
}

/** A group's heading: an MCP server reads as one, with how many of it are picked. */
export function groupHeading(group: Pick<ToolGroup, 'connector' | 'picked'>): string {
  const name = group.connector.startsWith('mcp-')
    ? `${group.connector.slice(4)} (MCP server)`
    : group.connector;
  return group.picked > 0 ? `${name} · ${group.picked} selected` : name;
}

/** What the list says when nothing shows. */
export function emptyListMessage(offeredCount: number): string {
  return offeredCount === 0 ? 'Connect an account to give your agents tools.' : 'No tools match.';
}

/** What a tool does to the world: reads it calls itself; changes it only proposes. */
export function toolKindLabel(kind: ToolDescriptor['kind']): string {
  return kind === 'read' ? 'reads' : 'changes — staged';
}
