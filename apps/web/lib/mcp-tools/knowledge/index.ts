/**
 * The Renkei MCP gateway's knowledge surface (RENKEI.md Phase 2):
 * `search_knowledge` exposes the gated retrieval path to LLM callers.
 *
 * The gate is the entire point. The index only proposes candidates; every
 * one is verified live against the source provider for the CALLING USER's
 * access before disclosure (Decisions #14/#18) — a WebEx chunk is returned
 * only if that user is in the room right now. Withheld candidates are
 * reported as a count, never silently dropped. No recorded email for the
 * caller means nothing can be verified, so nothing is disclosed.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { WEBEX_CONNECTOR, WebexClient, createWebexAccessVerifier } from '@renkei/connector-webex';
import { MICROSOFT_CONNECTOR, createMicrosoftAccessVerifier } from '@renkei/connector-microsoft';
import { ZOOM_CONNECTOR, createZoomAccessVerifier } from '@renkei/connector-zoom';
import type { AccessVerifier } from '@renkei/gates';
import { resolveEmbeddingProvider, searchKnowledge } from '@renkei/knowledge';
import type { MCPToolContext } from '../common';
import { logger } from '@/lib/logger';

/** The connector key knowledge capabilities register under. */
export const KNOWLEDGE_CONNECTOR = 'knowledge';

/**
 * The verifiers for every provider whose chunks might be proposed. A
 * provider without a configured connector contributes no verifier, and the
 * gate denies its chunks by default — never a silent pass.
 *
 * Exported so every caller of searchKnowledge — the MCP tool here, and the
 * self-service search page — wires the exact same ACL gate. Two verifier
 * sets built separately would drift the moment a connector is added.
 */
export async function buildKnowledgeVerifiers(
  tenantId: string
): Promise<ReadonlyMap<string, AccessVerifier>> {
  const verifiers = new Map<string, AccessVerifier>();
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return verifiers;

  const webexResult = await readConnectorConfigCached(tenantId, WEBEX_CONNECTOR, keyResult.val);
  if (webexResult.ok && webexResult.val?.enabled && webexResult.val.secrets.botToken) {
    verifiers.set(
      WEBEX_CONNECTOR,
      createWebexAccessVerifier(new WebexClient(webexResult.val.secrets.botToken))
    );
  }

  // Microsoft and Zoom chunks embed their owner in the refId, so their
  // verifiers are pure ownership checks — no client, no config needed. They
  // are registered unconditionally: with no chunks they never fire, and
  // without them every microsoft/zoom chunk would be default-denied.
  verifiers.set(MICROSOFT_CONNECTOR, createMicrosoftAccessVerifier());
  verifiers.set(ZOOM_CONNECTOR, createZoomAccessVerifier());

  return verifiers;
}

function formatDistance(distance: number): string {
  return Number.isFinite(distance) ? distance.toFixed(3) : String(distance);
}

export async function registerKnowledgeTools(
  server: McpServer,
  context: MCPToolContext
): Promise<void> {
  server.registerTool(
    'search_knowledge',
    {
      title: 'Knowledge · Read — Search org knowledge',
      description:
        'Semantic search over what Renkei has indexed from connected tools ' +
        '(WebEx today; Confluence and SharePoint as they arrive). Results are ' +
        'verified against the source system for YOUR access before disclosure — ' +
        'anything you cannot open at the source is withheld and reported as a count.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).max(2000).describe('What to search for, in natural language'),
        k: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum results to return (1-10, default 5)'),
      }),
    },
    async (args: Record<string, unknown>) => {
      logger.info('search_knowledge invoked', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        accountId: context.accountId,
      });

      const query = typeof args.query === 'string' ? args.query : '';
      const k = typeof args.k === 'number' ? Math.min(Math.max(Math.trunc(args.k), 1), 10) : 5;
      if (!query.trim()) {
        return { content: [{ type: 'text' as const, text: 'query is required' }], isError: true };
      }

      // No recorded email = nothing can be verified = nothing is disclosed.
      const userEmail = context.userEmail;
      if (!userEmail) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'Renkei has no email on record for your identity, so access to ' +
                'knowledge results cannot be verified. Sign in to Renkei again to refresh it.',
            },
          ],
          isError: true,
        };
      }

      const embedder = await resolveEmbeddingProvider(context.tenantId);
      if (!embedder) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'The knowledge layer is not configured for this organization (no embedding provider).',
            },
          ],
          isError: true,
        };
      }

      const verifiers = await buildKnowledgeVerifiers(context.tenantId);
      const searched = await searchKnowledge({
        tenantId: context.tenantId,
        userEmail,
        query,
        k,
        embedder,
        verifiers,
      });
      if (!searched.ok) {
        const reason =
          searched.err.type === 'EMBEDDING_FAILED'
            ? 'The embedding provider could not process the query.'
            : 'The knowledge store could not be searched.';
        return { content: [{ type: 'text' as const, text: reason }], isError: true };
      }

      const { hits, elided } = searched.val;
      const lines: string[] = [];
      if (hits.length === 0) {
        lines.push('No accessible results.');
      } else {
        lines.push(`${hits.length} result(s), closest first:`);
        for (const [index, hit] of hits.entries()) {
          const excerpt = hit.content.length <= 500 ? hit.content : `${hit.content.slice(0, 499)}…`;
          lines.push(
            '',
            `${index + 1}. [${hit.provider}:${hit.refId}] (distance ${formatDistance(hit.distance)})`,
            excerpt
          );
        }
      }
      if (elided > 0) {
        lines.push(
          '',
          `${elided} result(s) withheld: your access could not be verified at the source.`
        );
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );
}
