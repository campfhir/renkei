/**
 * The draft job: durability for a piece of work that lives in the web app.
 *
 * Drafting an agent from prose needs the requester's TOOL CATALOG, which is
 * built by running the whole MCP registration for a specific user against
 * the web app's module graph. That is not portable into this process, and
 * two copies of it would be worse than an HTTP hop. So this handler owns
 * what a worker is good at — retries, a process that outlives the browser
 * tab, ordering — and asks the web app to do the drafting over the same
 * internal URL the run engine already uses for MCP.
 *
 * The draft ROW is the source of truth throughout; this handler never
 * touches it. The web route claims it, does the work, and records the
 * outcome, so there is exactly one place that decides what a draft's status
 * means.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { mintRunToken, revokeRunToken } from './token';
import { logger } from './logger';

/** A draft may take a few minutes of model time; the token must outlast it. */
const TOKEN_TTL_SECONDS = 20 * 60;

interface DraftJobPayload {
  draftId: string;
}

function payloadOf(value: unknown): DraftJobPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record: { draftId?: unknown } = value;
  return typeof record.draftId === 'string' && record.draftId ? { draftId: record.draftId } : null;
}

/**
 * Which subject the token should name.
 *
 * Read from the draft row rather than taken from the job payload: the
 * payload is whatever was enqueued, and the subject decides whose tool
 * catalog the draft is built against. A payload that could name a subject
 * would be a payload that could borrow one.
 */
async function ownerOf(
  db: Kysely<DB>,
  tenantId: string,
  draftId: string
): Promise<{ subject: string; agentId: string | null } | null> {
  const row = await db
    .selectFrom('agent_drafts')
    .select(['owner_subject', 'agent_id', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', draftId)
    .executeTakeFirst();
  if (!row) return null;
  return { subject: row.owner_subject, agentId: row.agent_id };
}

/**
 * Just the part of `fetch` this handler uses.
 *
 * Narrower than `typeof fetch` on purpose: a test double then needs no type
 * assertion to satisfy it, and the signature says what is actually relied
 * on rather than implying the whole Fetch API is in play.
 */
type PostJson = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

export function createDraftHandler(deps: {
  db: Kysely<DB>;
  webBaseUrl: string;
  fetchImpl?: PostJson;
}) {
  const doFetch: PostJson = deps.fetchImpl ?? fetch;

  return async function handleDraft(event: {
    tenant_id: string;
    payload: unknown;
  }): Promise<'skipped' | undefined> {
    const payload = payloadOf(event.payload);
    if (!payload) throw new Error('draft job payload missing draftId');

    const owner = await ownerOf(deps.db, event.tenant_id, payload.draftId);
    if (!owner) {
      // The draft was deleted, or its agent was and took it with it. Nothing
      // to do and nothing wrong — retrying would never find it.
      logger.debug('draft {draftId} no longer exists; dropping the job', {
        component: 'worker-agents/draft',
        tenantId: event.tenant_id,
        draftId: payload.draftId,
      });
      return 'skipped';
    }

    const token = await mintRunToken(deps.db, {
      tenantId: event.tenant_id,
      subject: owner.subject,
      // Drafting acts as the PERSON, not as an agent — there is usually no
      // agent yet, and even when revising one the draft is the author's work.
      agentId: null,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });

    try {
      const url =
        `${deps.webBaseUrl}/api/tenant/${encodeURIComponent(event.tenant_id)}` +
        `/agents/draft/${encodeURIComponent(payload.draftId)}/run`;
      const response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });

      if (!response.ok) {
        // Thrown so the queue retries. The web route records a terminal
        // failure on the row before returning 500, so a retry finds the
        // draft already claimed and stops — the retry is for the cases
        // where the request never arrived at all.
        throw new Error(`drafting failed for ${payload.draftId}: HTTP ${response.status}`);
      }
      logger.debug('draft {draftId} completed', {
        component: 'worker-agents/draft',
        tenantId: event.tenant_id,
        draftId: payload.draftId,
      });
      return undefined;
    } finally {
      await revokeRunToken(deps.db, token);
    }
  };
}
