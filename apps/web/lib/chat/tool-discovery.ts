/**
 * find_tools — the model's way to reach the connectors a chat has enabled
 * beyond the core set (tool-surface.ts's `discoverable`), without every one
 * of them being declared on every turn. A keyword search over name,
 * connector and description; matches ride back as ordinary text AND as
 * `_meta.discoveredTools`, which turn-runner.ts reads to add them to the
 * turn's active tool set — callable from the very next model reply, no
 * different from a tool that was offered from the start. A discovery
 * outlives its turn: recallDiscoveredTools reads the chat's history for
 * what earlier turns surfaced and start-turn.ts offers those again, so a
 * tool the model found while planning is still callable, schema and all,
 * when the person answers its follow-up question a turn later.
 *
 * Deliberately not an MCP tool and not backed by embeddings: the catalog is
 * small enough (per chat, at most a few hundred entries) that a plain
 * substring score is fast and legible, and it costs nothing to keep in the
 * request-scoped closure below.
 */

import { z } from 'zod';
import type { LlmMessage, LlmToolDef } from '@renkei/agent-llm';
import type { DiscoverableTool } from './tool-surface';
import { errorResult, textResult, type LocalTool } from './local-tools';

export const FIND_TOOLS_NAME = 'find_tools';

/** Enough to cover a real need without dumping the whole catalog back. */
const MAX_MATCHES = 12;

/**
 * One matched tool as find_tools lists it, and the line's inverse. The
 * result is text on the transcript, so a later turn recovers the names
 * from that text (recallDiscoveredTools); keeping the two together is
 * what makes that recovery reliable.
 */
function matchLine(tool: LlmToolDef): string {
  return `- ${tool.name}: ${tool.description}`;
}
const MATCH_LINE = /^- ([^\s:]+):/gm;

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

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** A plain object view of an unknown value, or null — validated by zod, no type assertion needed. */
function rec(value: unknown): Record<string, unknown> | null {
  const result = jsonObjectSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** A JSON Schema node's type(s) as a short label — "number|string", "array", "any". */
function jsonSchemaTypeLabel(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.type)) {
    return schema.type.filter((entry): entry is string => typeof entry === 'string').join('|');
  }
  if (typeof schema.type === 'string') return schema.type;
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const labels = variants
      .map(rec)
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map(jsonSchemaTypeLabel)
      .filter(Boolean);
    return [...new Set(labels)].join('|') || 'any';
  }
  if (Array.isArray(schema.enum)) return 'enum';
  return 'any';
}

function summarizeProperty(
  name: string,
  schema: Record<string, unknown>,
  required: boolean
): string {
  const type = jsonSchemaTypeLabel(schema);
  const items = type === 'array' ? rec(schema.items) : null;
  const typeLabel = items ? `${jsonSchemaTypeLabel(items)}[]` : type;
  const description = typeof schema.description === 'string' ? schema.description : '';
  return (
    `${name} (${typeLabel}${required ? '' : ', optional'})` +
    (description ? `: ${description}` : '')
  );
}

/**
 * A one-line parameter listing for a tool's JSON Schema — so a model that
 * just discovered a tool through find_tools sees its shape (name, type,
 * required-ness, description) right in the search result text, not only
 * through whatever native tool-calling schema the provider surfaces once
 * the tool joins the active set. Empty for a tool with no properties.
 */
function summarizeInputSchema(schema: Record<string, unknown>): string {
  const properties = rec(schema.properties);
  if (!properties) return '';
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : []
  );
  return Object.entries(properties)
    .map(([name, propertySchema]) => [name, rec(propertySchema)] as const)
    .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null)
    .map(([name, propertySchema]) => summarizeProperty(name, propertySchema, required.has(name)))
    .join('; ');
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
        'become callable for the rest of this chat.',
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
          matches
            .map((tool) => {
              const params = summarizeInputSchema(tool.inputSchema);
              return matchLine(tool) + (params ? `\n  Parameters: ${params}` : '');
            })
            .join('\n'),
        { discoveredTools: matches }
      );
    },
  };
}

/**
 * The discoverable tools this chat already surfaced on an earlier turn:
 * every one the model has called by name, and every one a find_tools
 * result listed — read back from the transcript, so nothing is stored
 * for it. Offered again from the start of the next turn.
 *
 * Without this a discovery lasted one turn. The model, remembering the
 * tool from the turn before, would still call it — and with its schema
 * gone from the request it guessed the argument types, sending an array
 * as its JSON text, a number as a numeric string. Names are matched
 * against `discoverable`, never taken on trust from the text.
 */
export function recallDiscoveredTools(
  history: LlmMessage[],
  discoverable: DiscoverableTool[]
): LlmToolDef[] {
  if (discoverable.length === 0) return [];
  const known = new Set(discoverable.map((entry) => entry.def.name));
  const searches = new Set<string>();
  const recalled = new Set<string>();
  for (const message of history) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        if (block.name === FIND_TOOLS_NAME) searches.add(block.id);
        else if (known.has(block.name)) recalled.add(block.name);
      } else if (block.type === 'tool_result' && searches.has(block.toolUseId)) {
        for (const match of block.content.matchAll(MATCH_LINE)) {
          if (known.has(match[1])) recalled.add(match[1]);
        }
      }
    }
  }
  return discoverable.filter((entry) => recalled.has(entry.def.name)).map((entry) => entry.def);
}
