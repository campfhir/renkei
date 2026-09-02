/**
 * The optimization job: durability for an analysis that lives in the web app.
 *
 * Same shape as the draft job (draft.ts), for the same reason. Turning a
 * report into a revision needs the owner's TOOL CATALOG, and the report
 * itself reads run content under the owner's visibility rules — both are
 * the web app's module graph. This handler owns retries, ordering, and a
 * process that outlives the browser tab, and asks the web app to do the
 * analysis over the internal URL the run engine already uses for MCP.
 *
 * The optimization ROW is the source of truth throughout; this handler
 * never touches it. The web route claims it, does the work, and records
 * the outcome.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { mintRunToken, revokeRunToken } from './token';
import { logger } from './logger';

/** An analysis is one long model call; the token must outlast it. */
const TOKEN_TTL_SECONDS = 20 * 60;

interface OptimizeJobPayload {
  optimizationId: string;
}

function payloadOf(value: unknown): OptimizeJobPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record: { optimizationId?: unknown } = value;
  return typeof record.optimizationId === 'string' && record.optimizationId
    ? { optimizationId: record.optimizationId }
    : null;
}

/**
 * Which subject the token should name — read from the row, never the
 * payload, because the subject decides whose run content the analysis may
 * read and whose catalog a revision is built against.
 */
async function ownerOf(
  db: Kysely<DB>,
  tenantId: string,
  optimizationId: string
): Promise<{ subject: string; agentId: string } | null> {
  const row = await db
    .selectFrom('agent_optimizations')
    .select(['owner_subject', 'agent_id'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', optimizationId)
    .executeTakeFirst();
  if (!row) return null;
  return { subject: row.owner_subject, agentId: row.agent_id };
}

type PostJson = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

export function createOptimizeHandler(deps: {
  db: Kysely<DB>;
  webBaseUrl: string;
  fetchImpl?: PostJson;
}) {
  const doFetch: PostJson = deps.fetchImpl ?? fetch;

  return async function handleOptimize(event: {
    tenant_id: string;
    payload: unknown;
  }): Promise<'skipped' | undefined> {
    const payload = payloadOf(event.payload);
    if (!payload) throw new Error('optimize job payload missing optimizationId');

    const owner = await ownerOf(deps.db, event.tenant_id, payload.optimizationId);
    if (!owner) {
      logger.debug('optimization {optimizationId} no longer exists; dropping the job', {
        component: 'worker-agents/optimize',
        tenantId: event.tenant_id,
        optimizationId: payload.optimizationId,
      });
      return 'skipped';
    }

    const token = await mintRunToken(deps.db, {
      tenantId: event.tenant_id,
      subject: owner.subject,
      // The analysis acts as the PERSON: it reads their agent's history and
      // may start a revision draft on their behalf, exactly as they could.
      agentId: null,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });

    try {
      const url =
        `${deps.webBaseUrl}/api/tenant/${encodeURIComponent(event.tenant_id)}` +
        `/agents/optimize/${encodeURIComponent(payload.optimizationId)}/run`;
      const response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        // Thrown so the queue retries; the web route records a terminal
        // failure on the row before returning 500, so a retry finds the
        // row claimed and stops — the retry is for a request that never
        // arrived at all.
        throw new Error(
          `optimization failed for ${payload.optimizationId}: HTTP ${response.status}`
        );
      }
      logger.debug('optimization {optimizationId} completed', {
        component: 'worker-agents/optimize',
        tenantId: event.tenant_id,
        optimizationId: payload.optimizationId,
      });
      return undefined;
    } finally {
      await revokeRunToken(deps.db, token);
    }
  };
}
