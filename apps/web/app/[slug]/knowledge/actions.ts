'use server';

/**
 * Self-service semantic search over the knowledge store — the human-facing
 * twin of the `search_knowledge` MCP tool, so anyone can see what Renkei
 * has indexed for them without going through an LLM client.
 *
 * "For them" is the entire point: the searching identity is resolved from
 * the session cookie server-side, never taken from the client, and every
 * candidate still passes through the same live ACL gate `search_knowledge`
 * uses (buildKnowledgeVerifiers) — a WebEx chunk is returned only if this
 * signed-in user is actually in that room right now. There is no way to
 * search "as" anyone else from this page.
 */

import { getSessionFromCookies } from '@/lib/session';
import { getIdentityEmail } from '@/lib/identity';
import {
  resolveEmbeddingProvider,
  searchKnowledge,
  listRecentKnowledge,
  splitQuery,
} from '@renkei/knowledge';
import { parseLogQueryExpr } from '@campfhir/bored-logs';
import { buildKnowledgeVerifiers, sourceFiltersFor } from '@/lib/mcp-tools/knowledge';

const MIN_K = 1;
const MAX_K = 30;
const DEFAULT_K = 10;

export interface KnowledgeSearchHit {
  provider: string;
  refId: string;
  content: string;
  metadata: Record<string, unknown>;
  distance: number;
  /** The source document's own date, when the connector recorded one. */
  sourceAt: string | null;
}

/** What the page can narrow by — the same knobs search_knowledge exposes. */
export interface KnowledgeSearchFilters {
  /** Source names from KNOWLEDGE_SOURCE_NAMES; empty means everything. */
  sources?: string[];
  /** ISO-8601; undated items are excluded when either bound is set. */
  after?: string;
  before?: string;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[];
  elided: number;
  /** Of `elided`, how many the source failed to answer for in time. */
  unverified?: number;
  error: string | null;
  /** The cookie named no live session — the page should send them to sign in. */
  signedOut?: boolean;
  /** True when these are the newest items rather than matches for a query. */
  browsing?: boolean;
}

/**
 * Search the caller's own view of the knowledge store.
 *
 * Reachable by direct POST, not just through the UI, so the session — and
 * with it the identity the ACL gate verifies against — is resolved here on
 * every call. `tenantId` arriving from the client is safe because the
 * session cookie is per-tenant: it only names which cookie to read, and
 * produces no session for a tenant the caller has not signed into.
 */
export async function searchMyKnowledge(
  tenantId: string,
  query: string,
  k: number = DEFAULT_K,
  filters: KnowledgeSearchFilters = {}
): Promise<KnowledgeSearchResult> {
  const session = await getSessionFromCookies(tenantId);
  if (!session) {
    return { hits: [], elided: 0, error: 'Sign in to search your knowledge', signedOut: true };
  }

  const trimmedQuery = query.trim();
  // `key:value` narrows metadata; bare words search the vector. The parser
  // is bored-logs' — the same syntax the activity log takes — so what a
  // person already knows from filtering logs works here unchanged.
  const parsed = trimmedQuery ? parseLogQueryExpr(trimmedQuery) : null;
  const { terms, filter: metadataFilter } =
    parsed && parsed.ok ? splitQuery(parsed.val) : { terms: [], filter: null };
  // What is left after the filters are lifted out is what the embedder sees.
  // A query of ONLY filters ("reporter:Evan") has nothing to be semantically
  // similar to, so it browses the newest matching rows instead of embedding
  // an empty string.
  const semanticQuery = parsed && parsed.ok ? terms.join(' ').trim() : trimmedQuery;
  const clampedK = Math.min(Math.max(Math.trunc(k) || DEFAULT_K, MIN_K), MAX_K);

  // No recorded email = nothing can be verified = nothing is disclosed —
  // the same fail-closed rule search_knowledge enforces.
  const emailResult = await getIdentityEmail(tenantId, session.subject);
  const userEmail = emailResult.ok ? emailResult.val : null;
  if (!userEmail) {
    return {
      hits: [],
      elided: 0,
      error:
        'Renkei has no email on record for your identity, so access to results cannot be ' +
        'verified. Sign out and sign in again to refresh it.',
    };
  }

  // Source names map to provider/kind pairs in one place (the MCP tool's
  // module) so this page and the tool can never drift apart on what
  // 'outlook_mail' means.
  const sourceFilters = sourceFiltersFor(filters.sources ?? []);
  const verifiers = await buildKnowledgeVerifiers(tenantId);

  // No query yet: show the newest indexed items instead of an empty page,
  // so the filters double as a browser ("top 20 mail", "top 20 WebEx").
  // This path needs no embedder, so browsing still works for an org that
  // has not configured one.
  if (!semanticQuery) {
    const recent = await listRecentKnowledge({
      tenantId,
      userEmail,
      k: clampedK,
      verifiers,
      ...(sourceFilters.length > 0 ? { sources: sourceFilters } : {}),
      ...(filters.after ? { after: filters.after } : {}),
      ...(filters.before ? { before: filters.before } : {}),
      ...(metadataFilter ? { metadata: metadataFilter } : {}),
    });
    if (!recent.ok) {
      return { hits: [], elided: 0, error: 'The knowledge store could not be read.' };
    }
    return {
      hits: recent.val.hits,
      elided: recent.val.elided,
      unverified: recent.val.unverified,
      error: null,
      browsing: true,
    };
  }

  const embedder = await resolveEmbeddingProvider(tenantId);
  if (!embedder) {
    return {
      hits: [],
      elided: 0,
      error:
        'The knowledge layer is not configured for this organization yet — an admin sets up ' +
        'an embedding provider under Connector setup.',
    };
  }

  const searched = await searchKnowledge({
    tenantId,
    userEmail,
    query: semanticQuery,
    k: clampedK,
    embedder,
    verifiers,
    ...(sourceFilters.length > 0 ? { sources: sourceFilters } : {}),
    ...(filters.after ? { after: filters.after } : {}),
    ...(filters.before ? { before: filters.before } : {}),
    ...(metadataFilter ? { metadata: metadataFilter } : {}),
  });
  if (!searched.ok) {
    return {
      hits: [],
      elided: 0,
      error:
        searched.err.type === 'EMBEDDING_FAILED'
          ? 'The embedding provider could not process that query.'
          : 'The knowledge store could not be searched.',
    };
  }

  return {
    hits: searched.val.hits,
    elided: searched.val.elided,
    unverified: searched.val.unverified,
    error: null,
  };
}
