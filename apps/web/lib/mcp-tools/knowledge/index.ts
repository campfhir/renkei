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
import {
  createJiraAccessVerifier,
  createConfluenceAccessVerifier,
  JIRA_KNOWLEDGE_PROVIDER,
  CONFLUENCE_KNOWLEDGE_PROVIDER,
} from '@renkei/connector-atlassian';
import {
  getGrant,
  readAtlassianMetadata,
  ATLASSIAN,
  ATLASSIAN_CONFLUENCE,
} from '@renkei/provider-grants';
import { getDatabase } from '@renkei/db';
import type { AccessVerifier } from '@renkei/gates';
import type { KnowledgeHit } from '@renkei/knowledge';
import { resolveEmbeddingProvider, searchKnowledge, listRecentKnowledge } from '@renkei/knowledge';
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

  // Atlassian content has no owner encoded in its ref — a page is visible to
  // whoever the site says it is — so these verifiers ask Atlassian live,
  // with the CALLING user's own grant. Registered unconditionally for the
  // same reason as above: absent them, every jira/confluence chunk is
  // silently withheld, which looks identical to "nothing is indexed".
  const encryptionKey = keyResult.val;
  verifiers.set(
    JIRA_KNOWLEDGE_PROVIDER,
    createJiraAccessVerifier((userEmail) =>
      atlassianCredentialFor(tenantId, userEmail, ATLASSIAN, encryptionKey)
    )
  );
  verifiers.set(
    CONFLUENCE_KNOWLEDGE_PROVIDER,
    createConfluenceAccessVerifier((userEmail) =>
      atlassianCredentialFor(tenantId, userEmail, ATLASSIAN_CONFLUENCE, encryptionKey)
    )
  );

  return verifiers;
}

/**
 * The caller's own Atlassian credential, found from their email.
 *
 * The gate hands verifiers an EMAIL (the identity spine's key), while
 * grants are keyed by OIDC subject — so this hops identities → provider
 * grants. Anything missing returns null, which denies: a user who has not
 * connected the product cannot be shown its content on the index's word
 * alone.
 */
async function atlassianCredentialFor(
  tenantId: string,
  userEmail: string,
  provider: string,
  encryptionKey: Parameters<typeof getGrant>[3]
): Promise<{ accessToken: string; cloudId: string } | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;

  const row = await dbResult.val
    .selectFrom('identities')
    .innerJoin('provider_grants', (join) =>
      join
        .onRef('provider_grants.subject', '=', 'identities.subject')
        .onRef('provider_grants.tenant_id', '=', 'identities.tenant_id')
    )
    .select('provider_grants.provider_account_id')
    .where('identities.tenant_id', '=', tenantId)
    .where('identities.email', '=', userEmail)
    .where('provider_grants.provider', '=', provider)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;

  const grantResult = await getGrant(provider, tenantId, row.provider_account_id, encryptionKey);
  if (!grantResult.ok || !grantResult.val) return null;
  const site = readAtlassianMetadata(grantResult.val.metadata);
  if (!site.cloudId) return null;
  return { accessToken: grantResult.val.accessToken, cloudId: site.cloudId };
}

function formatDistance(distance: number): string {
  return Number.isFinite(distance) ? distance.toFixed(3) : String(distance);
}

/**
 * Caller-facing source names → the storage vocabulary. The stored
 * `provider` is the connector ('microsoft'), not the product a person
 * would name ('outlook'), and the finer split lives in `metadata.kind`
 * with a per-connector vocabulary. Mapping here means a caller never has
 * to know either, and the storage names stay free to change.
 */
const SOURCE_FILTERS: Record<string, { provider: string; kind?: string }> = {
  outlook_mail: { provider: 'microsoft', kind: 'msg' },
  outlook_calendar: { provider: 'microsoft', kind: 'evt' },
  outlook_tasks: { provider: 'microsoft', kind: 'task' },
  zoom: { provider: 'zoom' },
  webex: { provider: 'webex' },
  confluence: { provider: 'confluence' },
  jira: { provider: 'jira' },
};

export const KNOWLEDGE_SOURCE_NAMES = Object.keys(SOURCE_FILTERS);

/**
 * The source name a hit would have been filtered under — the inverse of
 * SOURCE_FILTERS. Results are labelled in the same vocabulary the `sources`
 * argument accepts, so a caller can narrow a follow-up query by copying the
 * token back; the storage provider alone can't do that, since `microsoft`
 * covers mail, calendar and tasks alike.
 */
function sourceNameOf(hit: KnowledgeHit): string {
  const kind = typeof hit.metadata.kind === 'string' ? hit.metadata.kind : undefined;
  for (const [name, filter] of Object.entries(SOURCE_FILTERS)) {
    if (filter.provider !== hit.provider) continue;
    if (filter.kind === undefined || filter.kind === kind) return name;
  }
  return hit.provider;
}

/**
 * Turn selected source names into provider/kind filters.
 *
 * Kinds are only applied when EVERY selected source pins one — mixing
 * 'outlook_mail' (kind 'msg') with 'zoom' (no kind) must not silently
 * drop the Zoom results, since the two filters are ANDed in SQL and no
 * Zoom chunk carries kind 'msg'.
 */
export function sourceFiltersFor(sources: readonly string[]): {
  providers?: string[];
  kinds?: string[];
} {
  const selected = sources.map((source) => SOURCE_FILTERS[source]).filter(Boolean);
  if (selected.length === 0) return {};
  const providers = [...new Set(selected.map((entry) => entry!.provider))];
  const kinds = selected.map((entry) => entry!.kind);
  const everySourcePinsAKind = kinds.every((kind) => kind !== undefined);
  return everySourcePinsAKind
    ? { providers, kinds: [...new Set(kinds.filter((kind): kind is string => Boolean(kind)))] }
    : { providers };
}

/** A hit's human title, from whichever metadata key its connector set. */
function titleOf(metadata: Record<string, unknown>): string {
  for (const key of ['subject', 'topic', 'title']) {
    const value = metadata[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/**
 * One renderer for both paths so search and browse can't drift in shape.
 * `browsing` only changes the wording — ordering is by recency there, and
 * a distance of 0 would be a lie if it were labelled as a match score.
 */
function renderHits(result: { hits: KnowledgeHit[]; elided: number }, browsing: boolean): string {
  const { hits, elided } = result;
  const lines: string[] = [];
  if (hits.length === 0) {
    lines.push(browsing ? 'Nothing indexed yet for those filters.' : 'No accessible results.');
  } else {
    lines.push(
      browsing
        ? `${hits.length} most recent indexed item(s), newest first:`
        : `${hits.length} result(s), closest first:`
    );
    for (const [index, hit] of hits.entries()) {
      const excerpt = hit.content.length <= 500 ? hit.content : `${hit.content.slice(0, 499)}…`;
      lines.push(
        '',
        `${index + 1}. ${titleOf(hit.metadata) || '(untitled)'}` +
          (hit.sourceAt ? ` — ${hit.sourceAt}` : '') +
          ` — ${sourceNameOf(hit)}` +
          ` — [${hit.provider}:${hit.refId}]` +
          (browsing ? '' : ` (distance ${formatDistance(hit.distance)})`),
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
  return lines.join('\n');
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
        'Semantic search over what Renkei has indexed from connected tools — ' +
        'Outlook mail/calendar/tasks, Confluence, Jira, Zoom and WebEx, as far as ' +
        'each has been indexed. Results are ' +
        'verified against the source system for YOUR access before disclosure — ' +
        'anything you cannot open at the source is withheld and reported as a count.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string()
          .max(2000)
          .describe(
            'What to search for, in natural language. Leave EMPTY to browse the most recent ' +
              'indexed items instead of searching — useful with `sources` to answer "what is in ' +
              'here?" or "what came in lately from Confluence?"'
          ),
        k: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum results to return (1-10, default 5)'),
        sources: z
          .array(
            z.enum([
              'outlook_mail',
              'outlook_calendar',
              'outlook_tasks',
              'zoom',
              'webex',
              'confluence',
              'jira',
            ])
          )
          .optional()
          .describe('Only search these sources (default: everything indexed)'),
        after: z
          .string()
          .optional()
          .describe(
            'Only items dated on/after this ISO-8601 time. Items the connector never dated are excluded.'
          ),
        before: z
          .string()
          .optional()
          .describe('Only items dated before this ISO-8601 time. Undated items are excluded.'),
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

      const sources = Array.isArray(args.sources)
        ? args.sources.filter((source): source is string => typeof source === 'string')
        : [];
      const { providers, kinds } = sourceFiltersFor(sources);
      const verifiers = await buildKnowledgeVerifiers(context.tenantId);

      // No query: answer with the newest indexed items rather than an
      // error. Needs no embedder, so "what's in here?" works even before an
      // org configures one.
      if (!query.trim()) {
        const recent = await listRecentKnowledge({
          tenantId: context.tenantId,
          userEmail,
          k,
          verifiers,
          ...(providers ? { providers } : {}),
          ...(kinds ? { kinds } : {}),
          ...(typeof args.after === 'string' && args.after ? { after: args.after } : {}),
          ...(typeof args.before === 'string' && args.before ? { before: args.before } : {}),
        });
        if (!recent.ok) {
          return {
            content: [{ type: 'text' as const, text: 'The knowledge store could not be read.' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: renderHits(recent.val, true) }] };
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

      const searched = await searchKnowledge({
        tenantId: context.tenantId,
        userEmail,
        query,
        k,
        embedder,
        verifiers,
        ...(providers ? { providers } : {}),
        ...(kinds ? { kinds } : {}),
        ...(typeof args.after === 'string' && args.after ? { after: args.after } : {}),
        ...(typeof args.before === 'string' && args.before ? { before: args.before } : {}),
      });
      if (!searched.ok) {
        const reason =
          searched.err.type === 'EMBEDDING_FAILED'
            ? 'The embedding provider could not process the query.'
            : 'The knowledge store could not be searched.';
        return { content: [{ type: 'text' as const, text: reason }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: renderHits(searched.val, false) }] };
    }
  );
}
