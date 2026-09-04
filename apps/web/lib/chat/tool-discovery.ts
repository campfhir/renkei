/**
 * find_tools — the model's way to reach the connectors a chat has enabled
 * beyond the core set (tool-surface.ts's `discoverable`), without every one
 * of them being declared on every turn. A keyword search over name,
 * connector and description; matches ride back as ordinary text AND as
 * `_meta.discoveredTools`, which turn-runner.ts reads to add them to the
 * turn's active tool set — callable from the very next model reply, no
 * different from a tool that was offered from the start.
 *
 * Deliberately not an MCP tool and not backed by embeddings: the catalog is
 * small enough (per chat, at most a few hundred entries) that a plain
 * substring score is fast and legible, and it costs nothing to keep in the
 * request-scoped closure below.
 */

import type { LlmToolDef } from '@renkei/agent-llm';
import type { DiscoverableTool } from './tool-surface';
import { errorResult, textResult, type LocalTool } from './local-tools';

export const FIND_TOOLS_NAME = 'find_tools';

/** Enough to cover a real need without dumping the whole catalog back. */
const MAX_MATCHES = 12;

function connectorSummaryOf(discoverable: DiscoverableTool[]): string {
  const counts = new Map<string, number>();
  for (const entry of discoverable) {
    counts.set(entry.connector, (counts.get(entry.connector) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([connector, count]) => `${connector} (${count})`)
    .join(', ');
}

function scoreOf(haystack: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (term.length > 0 && haystack.includes(term)) score += 1;
  }
  return score;
}

/**
 * `find_tools`, or null when the chat has nothing beyond its core tools —
 * offering a search over an empty catalog would just be a dead end.
 */
export function findToolsTool(discoverable: DiscoverableTool[]): LocalTool | null {
  if (discoverable.length === 0) return null;
  const summary = connectorSummaryOf(discoverable);

  return {
    readOnly: true,
    def: {
      name: FIND_TOOLS_NAME,
      description:
        'Search for tools from connectors enabled on this chat but not offered up front — ' +
        `${summary}. Call with a short query describing what you need to do (e.g. "create a ` +
        'jira issue", "search sharepoint files", or just a connector name), and matching tools ' +
        'become callable for the rest of this turn.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you need to do, or a connector name.' },
        },
        required: ['query'],
      },
    },
    async execute(input) {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) return errorResult('Give a query describing what you need, or a connector name.');
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = discoverable
        .map((entry) => ({
          entry,
          score: scoreOf(
            `${entry.connector} ${entry.def.name} ${entry.def.description}`.toLowerCase(),
            terms
          ),
        }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || a.entry.def.name.localeCompare(b.entry.def.name))
        .slice(0, MAX_MATCHES);
      if (scored.length === 0) {
        return errorResult(
          `No tools matched "${query}". Enabled connectors: ${summary}. Try different words, or search by connector name.`
        );
      }
      const matches: LlmToolDef[] = scored.map((row) => row.entry.def);
      return textResult(
        `Found ${matches.length} tool(s), now callable:\n` +
          matches.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n'),
        { discoveredTools: matches }
      );
    },
  };
}
