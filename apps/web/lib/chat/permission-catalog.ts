/**
 * Every act tool a chat of this person's could call, grouped the way the
 * Preferences page lists them: one fold per connector, plus the chat's
 * own tools and a code project's. The list a person decides against
 * ahead of time (permission-prefs.ts) — allow or block a tool before it
 * has ever been called, rather than only at the card.
 *
 * Connector tools come from the catalog, past every gate the person is
 * subject to (org policy, provisioning, roles), so a tool they could not
 * call is not offered to decide about. Read tools are left out: reading
 * never asks. The chat's own tools and the code tools are not in the
 * catalog (they run in-process, never over MCP), so their factories are
 * called with nothing behind them purely to read the names off — none of
 * them does anything until executed.
 */

import { friendlyToolName } from '@renkei/agents';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { listAvailableTools } from '@/lib/mcp-tools/tool-catalog';
import { codeDelegateTool } from '@/lib/code/delegate';
import { codeTools } from '@/lib/code/tools';
import { attachmentTools } from './attachment-tools';
import { compactionTools } from './compaction-tools';
import { fileTools } from './file-tools';
import { memoryTools } from './memory-tools';
import { userMemoryTools } from './user-memory-tools';
import type { LocalTool } from './local-tools';
import {
  CHAT_OWN_TOOLS_KEY,
  CODE_TOOLS_KEY,
  type ActToolEntry,
  type ActToolGroup,
} from './permission-rules';

export {
  CHAT_OWN_TOOLS_KEY,
  CODE_TOOLS_KEY,
  type ActToolEntry,
  type ActToolGroup,
} from './permission-rules';

function actNamesOf(tools: LocalTool[]): ActToolEntry[] {
  return tools
    .filter((tool) => tool.readOnly !== true)
    .map((tool) => ({ name: tool.def.name, label: friendlyToolName(tool.def.name, null) }));
}

/** The chat's in-process act tools: files, memory, compaction, staging. */
export function chatOwnActTools(): ActToolEntry[] {
  return dedupe([
    ...actNamesOf(compactionTools()),
    ...actNamesOf(attachmentTools({ connectors: ['sandbox'] })),
    ...actNamesOf(fileTools()),
    ...actNamesOf(memoryTools()),
    ...actNamesOf(userMemoryTools()),
  ]);
}

/** A code project's act tools, delegation included. */
export function codeActTools(): ActToolEntry[] {
  const bound = codeTools({
    target: { tenantId: '', subject: '' },
    workspaceId: '',
    repoFullName: '',
    origin: '',
  });
  return dedupe(actNamesOf([...bound, codeDelegateTool(bound)]));
}

function dedupe(entries: ActToolEntry[]): ActToolEntry[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => (seen.has(entry.name) ? false : (seen.add(entry.name), true)))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The connector's name as the catalog shows it; the key itself when unknown. */
function connectorLabel(key: string): string {
  return CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === key)?.label ?? key;
}

export async function listChatActToolGroups(
  tenantId: string,
  subject: string,
  roles: string[]
): Promise<ActToolGroup[]> {
  const catalog = await listAvailableTools(tenantId, subject, { roles });
  const byConnector = new Map<string, ActToolEntry[]>();
  for (const descriptor of catalog) {
    if (descriptor.kind !== 'act' || descriptor.appOnly) continue;
    if (descriptor.name.endsWith('_preview') || !descriptor.connector) continue;
    const list = byConnector.get(descriptor.connector) ?? [];
    list.push({
      name: descriptor.name,
      label: friendlyToolName(descriptor.name, descriptor.title),
    });
    byConnector.set(descriptor.connector, list);
  }
  const groups: ActToolGroup[] = [...byConnector.entries()]
    .map(([key, tools]) => ({ key, label: connectorLabel(key), tools: dedupe(tools) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  groups.push({ key: CHAT_OWN_TOOLS_KEY, label: 'The chat itself', tools: chatOwnActTools() });
  groups.push({ key: CODE_TOOLS_KEY, label: 'Code projects', tools: codeActTools() });
  return groups.filter((group) => group.tools.length > 0);
}
