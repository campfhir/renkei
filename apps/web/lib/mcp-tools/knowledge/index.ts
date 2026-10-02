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
import {
  WEBEX_CONNECTOR,
  WebexClient,
  createWebexUserAccessVerifier,
} from '@renkei/connector-webex';
import {
  MICROSOFT_CONNECTOR,
  createMicrosoftAccessVerifier,
  createSharepointAccessVerifier,
  SHAREPOINT_KNOWLEDGE_PROVIDER,
} from '@renkei/connector-microsoft';
import { ZOOM_CONNECTOR, createZoomAccessVerifier } from '@renkei/connector-zoom';
import {
  createJiraAccessVerifier,
  createConfluenceAccessVerifier,
  JIRA_KNOWLEDGE_PROVIDER,
  CONFLUENCE_KNOWLEDGE_PROVIDER,
} from '@renkei/connector-atlassian';
import {
  readAtlassianMetadata,
  ATLASSIAN,
  ATLASSIAN_CONFLUENCE,
  MICROSOFT,
} from '@renkei/provider-grants';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { getDatabase } from '@renkei/db';
import type { AccessVerifier } from '@renkei/gates';
import { withheldNote } from '@renkei/gates';
import type { KnowledgeHit, SourceFilter } from '@renkei/knowledge';
import {
  resolveKnowledge,
  searchKnowledge,
  listRecentKnowledge,
  relevanceOf,
  RELEVANCE_LABELS,
  titleOf,
  NOTE_KNOWLEDGE_PROVIDER,
  createNoteAccessVerifier,
} from '@renkei/knowledge';
import type { MCPToolContext } from '../common';
import { registerKnowledgeNoteTools } from './notes';
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

  // WebEx verifies with the CALLING user's own grant — there is no bot.
  // No grant on file → webex chunks stay default-denied, the gate's
  // contract; the resolver is imported lazily to keep this module's load
  // graph unchanged for callers that never search webex content.
  verifiers.set(
    WEBEX_CONNECTOR,
    createWebexUserAccessVerifier(async (userEmail) => {
      const { resolveWebexUserAccessByEmail } = await import('@/lib/webex-user-access');
      const access = await resolveWebexUserAccessByEmail(tenantId, userEmail);
      // Interactive: this client exists to answer a live search.
      return access ? new WebexClient(access.auth, { lane: 'interactive' }) : null;
    })
  );

  // Microsoft and Zoom chunks embed their owner in the refId, so their
  // verifiers are pure ownership checks — no client, no config needed. They
  // are registered unconditionally: with no chunks they never fire, and
  // without them every microsoft/zoom chunk would be default-denied.
  verifiers.set(MICROSOFT_CONNECTOR, createMicrosoftAccessVerifier());
  verifiers.set(ZOOM_CONNECTOR, createZoomAccessVerifier());
  // Authored notes are the same shape: the author's email IS the ref
  // prefix, so verification is a pure ownership check — only the author
  // (and, acting as them, their agents) ever reads a note.
  verifiers.set(NOTE_KNOWLEDGE_PROVIDER, createNoteAccessVerifier());

  // Atlassian content has no owner encoded in its ref — a page is visible to
  // whoever the site says it is — so these verifiers ask Atlassian live,
  // with the CALLING user's own grant. Registered unconditionally for the
  // same reason as above: absent them, every jira/confluence chunk is
  // silently withheld, which looks identical to "nothing is indexed".
  verifiers.set(
    JIRA_KNOWLEDGE_PROVIDER,
    createJiraAccessVerifier((userEmail) => atlassianCredentialFor(tenantId, userEmail, ATLASSIAN))
  );
  verifiers.set(
    CONFLUENCE_KNOWLEDGE_PROVIDER,
    createConfluenceAccessVerifier((userEmail) =>
      atlassianCredentialFor(tenantId, userEmail, ATLASSIAN_CONFLUENCE)
    )
  );

  // Drive documents are the one Microsoft surface where ownership is NOT the
  // ACL — a file is shared — so this asks Graph live on the caller's own
  // grant rather than reading an owner out of the ref. Registered
  // unconditionally for the same reason as the pair above.
  verifiers.set(
    SHAREPOINT_KNOWLEDGE_PROVIDER,
    createSharepointAccessVerifier((userEmail) => microsoftCredentialFor(tenantId, userEmail))
  );

  return verifiers;
}

/**
 * The OIDC subject behind an email, or null. The gate hands verifiers an
 * EMAIL (the identity spine's key), while grants are keyed by subject — so
 * every credential lookup below hops identities → the delegate's grant.
 */
async function subjectOf(tenantId: string, userEmail: string): Promise<string | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const row = await dbResult.val
    .selectFrom('identities')
    .select('subject')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', userEmail)
    .limit(1)
    .executeTakeFirst();
  return row?.subject ?? null;
}

/**
 * The caller's own Atlassian credential, found from their email: a fetcher
 * on their grant and the site it was minted for. Anything missing returns
 * null, which denies: a user who has not connected the product cannot be
 * shown its content on the index's word alone. No token is read here — the
 * delegate describes the grant (for the cloud id) and authenticates the
 * fetcher itself.
 */
async function atlassianCredentialFor(
  tenantId: string,
  userEmail: string,
  provider: string
): Promise<{ auth: AuthedFetch; cloudId: string } | null> {
  const subject = await subjectOf(tenantId, userEmail);
  if (!subject) return null;

  const described = await delegateGrants().describe({ tenantId, provider, subject });
  if (!described.ok) return null;
  const site = readAtlassianMetadata(described.val.metadata);
  if (!site.cloudId) return null;
  return {
    auth: grantFetch({ tenantId, provider, accountId: described.val.accountId }),
    cloudId: site.cloudId,
  };
}

/**
 * The caller's own Microsoft credential, found from their email.
 *
 * Freshness is the delegate's job now: the fetcher it hands back refreshes
 * the hour-long Graph token before a call and retries once on a 401, so a
 * stale token no longer presents as "SharePoint search returns nothing".
 * What stays here is the scope check — returning null on a missing
 * Files.Read.All denies immediately, which is cheaper than 20 sub-request
 * 403s and gives one place to see why a user's SharePoint results are empty.
 */
async function microsoftCredentialFor(
  tenantId: string,
  userEmail: string
): Promise<{ auth: AuthedFetch } | null> {
  const subject = await subjectOf(tenantId, userEmail);
  if (!subject) return null;

  const described = await delegateGrants().describe({ tenantId, provider: MICROSOFT, subject });
  if (!described.ok) return null;
  const { accountId, grantedScopes, requestedScopes } = described.val;

  const scopes = grantedScopes ?? requestedScopes;
  if (!scopes.includes('Files.Read.All')) {
    logger.info('microsoft grant lacks Files.Read.All; withholding drive results', {
      component: 'knowledge/verify',
      tenantId,
      accountId,
    });
    return null;
  }

  return { auth: grantFetch({ tenantId, provider: MICROSOFT, accountId }) };
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
 *
 * Outlook mail and calendar are not here on purpose: they are personal and
 * are never indexed (migration 135 dropped what had been). To Do tasks are
 * the one Outlook kind in the index, and the kind pin keeps the filter
 * honest should another Microsoft kind ever be stored.
 */
const SOURCE_FILTERS: Record<string, { provider: string; kind?: string }> = {
  outlook_tasks: { provider: 'microsoft', kind: 'task' },
  zoom: { provider: 'zoom' },
  webex: { provider: 'webex' },
  confluence: { provider: 'confluence' },
  jira: { provider: 'jira' },
  // Drive documents live under their own provider key rather than
  // 'microsoft', because the provider column is what selects the ACL
  // verifier and these need the live one, not mail's ownership check. No
  // `kind` pin: 'doc' is the only kind stored there.
  sharepoint: { provider: 'sharepoint' },
  // Authored notes (knowledge_create_note) — private to their author.
  notes: { provider: 'note' },
};

export const KNOWLEDGE_SOURCE_NAMES = Object.keys(SOURCE_FILTERS);

/**
 * The source name a hit would have been filtered under — the inverse of
 * SOURCE_FILTERS. Results are labelled in the same vocabulary the `sources`
 * argument accepts, so a caller can narrow a follow-up query by copying the
 * token back; the storage provider alone can't do that, since `microsoft`
 * is a connector name, not a source a person would type.
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
 * Turn selected source names into the provider/kind pairs the knowledge
 * layer ORs together.
 *
 * Each name keeps its own kind. An earlier version handed back separate
 * provider and kind lists, which the SQL then AND-ed: selecting a kinded
 * source plus Jira had to drop the kind to keep Jira, and silently widened
 * the kinded source to every kind its provider stored.
 */
export function sourceFiltersFor(sources: readonly string[]): SourceFilter[] {
  return sources
    .map((source) => SOURCE_FILTERS[source])
    .filter((filter): filter is { provider: string; kind?: string } => Boolean(filter))
    .map((filter) =>
      filter.kind ? { provider: filter.provider, kind: filter.kind } : { provider: filter.provider }
    );
}

/**
 * How a hit was found and how well, for the model reading the list. The
 * relevance word is graded against the org's cutoff when one is set (see
 * relevanceOf), so it means the same thing whichever embedding model the
 * org runs; the raw distance stays for anyone comparing within one list.
 * "keyword match" flags a hit the lexical arm found — worth saying, since
 * its distance may look poor while the match is exact.
 */
function matchNote(hit: KnowledgeHit, maxDistance: number | null): string {
  const grade = RELEVANCE_LABELS[relevanceOf(hit.distance, maxDistance)].toLowerCase();
  const keyword = hit.matched === 'lexical' || hit.matched === 'both' ? ', keyword match' : '';
  return ` (${grade}, distance ${formatDistance(hit.distance)}${keyword})`;
}

/**
 * One renderer for both paths so search and browse can't drift in shape.
 * `browsing` only changes the wording — ordering is by recency there, and
 * a distance of 0 would be a lie if it were labelled as a match score.
 */
function renderHits(
  result: { hits: KnowledgeHit[]; elided: number; unverified: number; weak?: number },
  browsing: boolean,
  maxDistance: number | null
): string {
  const { hits, elided, unverified } = result;
  const weak = result.weak ?? 0;
  const lines: string[] = [];
  if (hits.length === 0) {
    lines.push(browsing ? 'Nothing indexed yet for those filters.' : 'No accessible results.');
  } else {
    lines.push(
      browsing
        ? `${hits.length} most recent indexed item(s), newest first:`
        : `${hits.length} result(s), best match first:`
    );
    for (const [index, hit] of hits.entries()) {
      const excerpt = hit.content.length <= 500 ? hit.content : `${hit.content.slice(0, 499)}…`;
      lines.push(
        '',
        `${index + 1}. ${titleOf(hit.metadata) || '(untitled)'}` +
          (hit.sourceAt ? ` — ${hit.sourceAt}` : '') +
          ` — ${sourceNameOf(hit)}` +
          ` — [${hit.provider}:${hit.refId}]` +
          (browsing ? '' : matchNote(hit, maxDistance)),
        excerpt
      );
    }
  }
  // Said even when nothing came back: "no results" and "only weak results,
  // hidden" call for different next moves (rephrase vs. give up). But the
  // advice to rephrase is for the empty case only — beside a list of good
  // hits it reads as "search again", and a model that obeys it searches
  // again on every call, since some candidate is always past the cutoff.
  if (weak > 0) {
    lines.push(
      '',
      `${weak} weaker match(es) omitted: beyond the organization's relevance cutoff.` +
        (hits.length === 0
          ? ' Rephrase, quote an exact identifier, or narrow with `sources` to see closer matches.'
          : '')
    );
  }
  // Refusal and timeout are different facts and are worded differently; the
  // gate owns that phrasing so every surface says the same thing.
  const withheld = withheldNote(elided, unverified);
  if (withheld) lines.push('', withheld.trim());
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
        'Search over what Renkei has indexed from connected tools — ' +
        'Outlook tasks, Confluence, Jira, Zoom, WebEx and SharePoint, as far as ' +
        'each has been indexed — plus your own notes (knowledge_create_note). Mail and ' +
        'calendar are never indexed; use the outlook_* tools to read them live. Matches by ' +
        "meaning AND by exact words, so a ticket key, file name or person's name in the " +
        'query finds the item that carries it; quote a phrase to require it. One result ' +
        'per document, best match first; ask for as many as you need in one call (k up ' +
        'to 10) rather than searching repeatedly. Results are ' +
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
            z.enum(['outlook_tasks', 'zoom', 'webex', 'confluence', 'jira', 'sharepoint', 'notes'])
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
      logger.debug('search_knowledge invoked', {
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
      const sourceFilters = sourceFiltersFor(sources);
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
          ...(sourceFilters.length > 0 ? { sources: sourceFilters } : {}),
          ...(typeof args.after === 'string' && args.after ? { after: args.after } : {}),
          ...(typeof args.before === 'string' && args.before ? { before: args.before } : {}),
        });
        if (!recent.ok) {
          return {
            content: [{ type: 'text' as const, text: 'The knowledge store could not be read.' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text' as const, text: renderHits(recent.val, true, null) }] };
      }

      const knowledge = await resolveKnowledge(context.tenantId);
      if (!knowledge) {
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
        embedder: knowledge.embedder,
        maxDistance: knowledge.maxDistance,
        // A model asked for k results wants k documents, not k pieces of
        // the longest one.
        perDocument: true,
        verifiers,
        ...(sourceFilters.length > 0 ? { sources: sourceFilters } : {}),
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
      // Where the time went, per search. A slow search is one of three
      // things — the embedding endpoint, the query (an exact scan, until
      // the corpus earns an ANN index) or a provider's access check — and
      // only the split says which; the tool_calls row keeps the total.
      logger.info('search_knowledge timings', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        k,
        hits: searched.val.hits.length,
        elided: searched.val.elided,
        weak: searched.val.weak,
        ...searched.val.timings,
      });

      return {
        content: [
          { type: 'text' as const, text: renderHits(searched.val, false, knowledge.maxDistance) },
        ],
      };
    }
  );

  registerKnowledgeNoteTools(server, context);
}
