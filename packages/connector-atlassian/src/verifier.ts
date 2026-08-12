/**
 * The Jira and Confluence verifyAccess implementations (connector data
 * contract item #5; RENKEI.md Decision #18).
 *
 * Both work the same way and lean on the same property: asking Atlassian
 * for a batch of items **with the requesting user's own credential**
 * returns only the ones that user can actually see. Permission filtering is
 * therefore inherent to the response — we never interpret a permission
 * model ourselves, we just observe what came back. That is the "user still
 * has to call the API" liveness check, done as one call per batch rather
 * than one per item.
 *
 * Everything unresolvable — no grant for that user, an API failure, a
 * malformed ref — denies, per the gate's default-deny contract. Note a
 * transport failure and a permission denial must NOT be conflated: both
 * deny here, but only the former is worth retrying, which is why
 * atlassianFetch surfaces the status.
 */

import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { atlassianFetch, listOf, rec, str } from './client';

/** How the caller's Atlassian credential is found, given only their email. */
export interface AtlassianCredentialLookup {
  /**
   * Resolve the access token + cloud id for this user, or null when they
   * have no usable grant. Null denies every ref in the batch, which is
   * correct: a user with no Confluence connection cannot be shown
   * Confluence content on the strength of the index alone.
   */
  (userEmail: string): Promise<{ accessToken: string; cloudId: string } | null>;
}

/** Jira refs are the issue key, chunk suffix included: `PROJ-123#0001`. */
export function jiraRefId(issueKey: string): string {
  return issueKey;
}

/** Confluence refs are the page id, chunk suffix included: `12345#0001`. */
export function confluenceRefId(pageId: string): string {
  return pageId;
}

/** Strip the `#0001` chunk suffix chunkRefId appends, leaving the source id. */
function baseIdOf(refId: string): string {
  const hash = refId.indexOf('#');
  return hash > 0 ? refId.slice(0, hash) : refId;
}

/** Distinct source ids in a batch — many chunks routinely share one document. */
function distinctIds(refs: readonly SourceRef[]): string[] {
  return [...new Set(refs.map((ref) => baseIdOf(ref.refId)).filter(Boolean))];
}

function allowRefsFor(refs: readonly SourceRef[], visible: ReadonlySet<string>): SourceRef[] {
  return refs
    .filter((ref) => visible.has(baseIdOf(ref.refId)))
    .map((ref) => ({ provider: ref.provider, refId: ref.refId }));
}

/** Chunk so a huge candidate set can't build a JQL clause the API refuses. */
const BATCH_SIZE = 50;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function createJiraAccessVerifier(lookup: AtlassianCredentialLookup): AccessVerifier {
  return {
    provider: 'jira',
    async verifyAccess(
      userEmail: string,
      refs: readonly SourceRef[]
    ): Promise<Result<SourceRef[], 'VERIFICATION_FAILED'>> {
      const keys = distinctIds(refs);
      if (keys.length === 0) return ok([]);

      const credential = await lookup(userEmail).catch(() => null);
      if (!credential) return ok([]);

      const visible = new Set<string>();
      for (const batch of chunked(keys, BATCH_SIZE)) {
        // `key IN (...)` returns only issues this token can read, so the
        // response IS the permission answer — we never evaluate Jira's
        // permission scheme ourselves.
        const jql = `key IN (${batch.map((key) => `"${key.replace(/"/g, '')}"`).join(',')})`;
        const response = await atlassianFetch({
          product: 'jira',
          cloudId: credential.cloudId,
          accessToken: credential.accessToken,
          path: '/rest/api/3/search/jql',
          method: 'POST',
          json: { jql, fields: ['key'], maxResults: batch.length },
        });
        // A failed batch leaves its ids unverified, hence denied. Deliberately
        // not `return err(...)`: one broken batch must not deny the batches
        // that did answer.
        if (!response.ok) continue;
        for (const issue of listOf(response.body, 'issues')) {
          const key = str(issue.key);
          if (key) visible.add(key);
        }
      }

      return ok(allowRefsFor(refs, visible));
    },
  };
}

export function createConfluenceAccessVerifier(lookup: AtlassianCredentialLookup): AccessVerifier {
  return {
    provider: 'confluence',
    async verifyAccess(
      userEmail: string,
      refs: readonly SourceRef[]
    ): Promise<Result<SourceRef[], 'VERIFICATION_FAILED'>> {
      const ids = distinctIds(refs);
      if (ids.length === 0) return ok([]);

      const credential = await lookup(userEmail).catch(() => null);
      if (!credential) return ok([]);

      const visible = new Set<string>();
      for (const batch of chunked(ids, BATCH_SIZE)) {
        // Same property as Jira's: the multi-id filter returns only pages
        // this token can read.
        const query = batch.map((id) => `id=${encodeURIComponent(id)}`).join('&');
        const response = await atlassianFetch({
          product: 'confluence',
          cloudId: credential.cloudId,
          accessToken: credential.accessToken,
          path: `/wiki/api/v2/pages?${query}&limit=${batch.length}`,
        });
        if (!response.ok) continue;
        for (const page of listOf(response.body, 'results')) {
          const id = str(page.id) || String(rec(page).id ?? '');
          if (id) visible.add(id);
        }
      }

      return ok(allowRefsFor(refs, visible));
    },
  };
}
