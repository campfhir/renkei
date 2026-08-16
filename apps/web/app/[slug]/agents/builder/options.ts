/**
 * What the insert menu offers — tools and variables flattened into one
 * option shape, built once per builder render from the server-fetched
 * catalog and the draft's current triggers/saveAs names.
 */

import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import type { VariableDescriptor } from '@renkei/agents';
import { friendlyToolName } from '@/lib/tool-name';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';

export interface ToolOption {
  kind: 'tool';
  name: string;
  label: string;
  description: string;
  /** Connector display label, for grouping. */
  group: string;
  connector: string | null;
}

export interface VariableOption {
  kind: 'var';
  name: string;
  label: string;
  description: string;
}

export type InsertOption = ToolOption | VariableOption;

const connectorLabels = new Map(
  CONNECTOR_CATALOG.map((entry) => [entry.capabilityKey, entry.label])
);

export function toToolOptions(tools: ToolDescriptor[]): ToolOption[] {
  return tools
    .filter((tool) => !tool.appOnly)
    .map((tool) => ({
      kind: 'tool' as const,
      name: tool.name,
      label: friendlyToolName(tool.name, tool.title),
      description: tool.description ?? '',
      group: (tool.connector && connectorLabels.get(tool.connector)) || 'Other',
      connector: tool.connector,
    }));
}

export function toVariableOptions(variables: VariableDescriptor[]): VariableOption[] {
  return variables.map((variable) => ({
    kind: 'var' as const,
    name: variable.name,
    label: variable.label,
    description: variable.description,
  }));
}

/** True when `word` appears as a subsequence of `text` (j, r, a → "jira"). */
function subsequence(word: string, text: string): boolean {
  let at = 0;
  for (const char of text) {
    if (char === word[at]) at += 1;
    if (at === word.length) return true;
  }
  return false;
}

/**
 * Relevance of an option for a query, or null for no match. Deliberately
 * NOT exact-substring-in-order: the query splits into words, every word
 * may hit anywhere (label, wire name, description) in any order, and a
 * longer word may match as a subsequence — "comment jira" finds "Jira ·
 * Add a comment" as readily as the reverse. Prefix and word-boundary hits
 * on the label outrank buried ones, so the list reads best-first.
 */
export function scoreOption(option: InsertOption, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const label = option.label.toLowerCase();
  const name = option.name.toLowerCase();
  const description = option.description.toLowerCase();

  let total = 0;
  for (const word of words) {
    let best = 0;
    if (label.startsWith(word)) best = 30;
    else if (label.includes(` ${word}`)) best = 20;
    else if (label.includes(word)) best = 12;
    else if (name.includes(word)) best = 8;
    else if (description.includes(word)) best = 4;
    else if (word.length >= 3 && subsequence(word, label)) best = 2;
    if (best === 0) return null; // every word must land somewhere
    total += best;
  }
  return total;
}

export function matchesQuery(option: InsertOption, query: string): boolean {
  return scoreOption(option, query) !== null;
}

/** Filter + rank, best first; stable for equal scores. */
export function rankOptions<T extends InsertOption>(options: T[], query: string): T[] {
  return options
    .map((option, index) => ({ option, index, score: scoreOption(option, query) }))
    .filter((entry): entry is { option: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.option);
}
