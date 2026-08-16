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

export function matchesQuery(option: InsertOption, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    option.label.toLowerCase().includes(needle) ||
    option.name.toLowerCase().includes(needle) ||
    option.description.toLowerCase().includes(needle)
  );
}
