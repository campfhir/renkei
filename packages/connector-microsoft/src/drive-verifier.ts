/**
 * The verifyAccess implementation for drive documents (connector data
 * contract item #5; RENKEI.md Decision #18).
 *
 * This is the one Microsoft surface where ownership is NOT the ACL. Mail,
 * calendar and to-do items are indexed into their owner's view alone, so
 * verifier.ts can answer from the refId alone. A document is shared — with
 * named people, with groups, with a link, sometimes with the whole tenant —
 * and SharePoint's permission model (inheritance, unique permissions on a
 * subsite or a single item, nested groups, sharing links, guest access) is
 * not something to reimplement and could not be answered from the index
 * anyway.
 *
 * So we ask Graph, as the requesting user: fetch each candidate item with
 * THEIR delegated token and keep what comes back 200. The response IS the
 * permission answer. Anything else — 403, 404, a throttle, a timeout — is
 * not an affirmative grant and therefore denies, per the gate's default-deny
 * contract.
 *
 * Cost is bounded by the caller: searchKnowledge overfetches max(k*2, k+4)
 * with k <= 10, so a verifier is never handed more than 20 refs — exactly one
 * Graph $batch. Many chunks routinely share one document, so the distinct-id
 * collapse below usually makes it fewer.
 */

import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { graphRequest } from './client';
import { partsOfSharepointRefId, SHAREPOINT_KNOWLEDGE_PROVIDER } from './drive-refs';

/**
 * Graph's JSON batch limit. Not a tuning knob — 21 sub-requests is a 400.
 */
const BATCH_SIZE = 20;

/**
 * The gate races a 3s budget by default, while client.ts's request timeout is
 * 15s — five times longer. Without our own signal a slow batch would burn the
 * whole budget and elide every result, so we impose a tighter one and let the
 * gate keep its margin.
 */
const VERIFY_TIMEOUT_MS = 2_500;

/**
 * Resolving the CALLER's own Graph credential.
 *
 * Must return a token that is fresh: Microsoft access tokens live about an
 * hour, and a stale one 401s every sub-request. Because the gate denies on
 * anything that is not an affirmative 200, that failure is invisible — it
 * presents as "SharePoint search returns nothing", indistinguishable from
 * "nothing is indexed". Refresh proactively in the lookup; do not rely on
 * retrying a 401 inside the verification budget.
 *
 * Return null to deny everything — no credential, no disclosure. Returning
 * null when the grant lacks Files.Read.All is deliberate and cheaper than
 * discovering it as 20 sub-request 403s.
 */
export interface MicrosoftCredentialLookup {
  (userEmail: string): Promise<{ accessToken: string } | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function createSharepointAccessVerifier(lookup: MicrosoftCredentialLookup): AccessVerifier {
  return {
    provider: SHAREPOINT_KNOWLEDGE_PROVIDER,
    async verifyAccess(
      userEmail: string,
      refs: readonly SourceRef[]
    ): Promise<Result<SourceRef[], 'VERIFICATION_FAILED'>> {
      // Distinct documents, not distinct chunks: a 10-hit search is commonly
      // 4-8 documents, and each saved id is a saved sub-request.
      const parsed = new Map<string, { driveId: string; itemId: string }>();
      for (const ref of refs) {
        const parts = partsOfSharepointRefId(ref.refId);
        // A malformed ref is unresolvable, so it stays out of the visible set
        // and is denied — never guessed at.
        if (parts) parsed.set(`${parts.driveId}/${parts.itemId}`, parts);
      }
      if (parsed.size === 0) return ok([]);

      const credential = await lookup(userEmail).catch(() => null);
      if (!credential) return ok([]);

      const visible = new Set<string>();
      for (const batch of chunked([...parsed.entries()], BATCH_SIZE)) {
        const requests = batch.map(([key, parts], index) => ({
          id: String(index),
          method: 'GET',
          url: `/drives/${encodeURIComponent(parts.driveId)}/items/${encodeURIComponent(
            parts.itemId
          )}?$select=id`,
          // Correlate by position; `key` is recovered from `batch` below.
          _key: key,
        }));

        const response = await graphRequest(credential.accessToken, '/$batch', {
          method: 'POST',
          body: JSON.stringify({
            requests: requests.map(({ _key, ...request }) => request),
          }),
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
          // Inside the retrieval gate's budget — must not queue behind a sweep.
          lane: 'interactive',
        });
        // A failed batch leaves its ids unverified, hence denied. Deliberately
        // not `return err(...)`: one broken batch must not deny the batches
        // that did answer.
        if (!response.ok) continue;

        const body = isRecord(response.val) ? response.val : {};
        const responses = Array.isArray(body.responses) ? body.responses : [];
        for (const entry of responses) {
          if (!isRecord(entry)) continue;
          if (entry.status !== 200) continue;
          const index = Number(entry.id);
          const matched = requests[index];
          if (matched) visible.add(matched._key);
        }
      }

      const allowed = refs.filter((ref) => {
        const parts = partsOfSharepointRefId(ref.refId);
        return parts !== null && visible.has(`${parts.driveId}/${parts.itemId}`);
      });
      return ok(allowed.map((ref) => ({ provider: ref.provider, refId: ref.refId })));
    },
  };
}
