/**
 * The mailjobs/bulk-action handler: executes one mail_bulk_jobs row — the
 * async form of the retired outlook_bulk_* tools. The queue message is a
 * bare { jobId } pointer; this row is the source of truth and the status
 * tool's read model, so counts are updated incrementally as chunks settle.
 *
 * Jobs are SINGLE-EFFECTIVE-ATTEMPT: a redelivery that finds the row
 * 'running' means a worker died mid-job. It is finalized as failed/partial,
 * never re-executed — /move returns NEW message ids, so a blind re-run
 * double-acts on a mailbox. Requeue is a fresh submit.
 *
 * Deliberately NO org read-only check here: the submit tool was gated when
 * the job was accepted, and an accepted job runs to completion (the submit
 * tool's description says so).
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import {
  graphBatch,
  buildMailQueryPath,
  clientSideSelect,
  graphRequest,
  matchesClientSide,
  withCategoryChanges,
  GRAPH_BASE_URL,
  type BatchRequestItem,
  type BatchResultItem,
  type MailSearchFilters,
} from '@renkei/connector-microsoft';
import type { EventHandler } from '../handlers';
import { resolveMicrosoftAccess } from './microsoft-access';
import { logger } from '../logger';

const COMPONENT = 'mailjobs/run';

/** Hard ceiling on how many messages one job may touch. */
export const MAX_JOB_MESSAGES = 1_000;
/** Default when a filter selection names no maxMessages. */
export const DEFAULT_JOB_MESSAGES = 500;
/** Filter expansion pages (100/page) — bounded like every other scan here. */
const EXPANSION_PAGE_BUDGET = 15;
/** The status tool renders at most this many per-message failures. */
const FAILURES_KEPT = 20;

interface JobFailure {
  id: string;
  error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && !!entry)
    : [];
}

/** The selection's message ids — explicit, or expanded from filters via Graph. */
async function expandSelection(
  accessToken: string,
  selection: Record<string, unknown>
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const explicit = strings(selection.messageIds);
  if (explicit.length > 0) return { ok: true, ids: explicit.slice(0, MAX_JOB_MESSAGES) };

  const filtersRaw = isRecord(selection.filters) ? selection.filters : null;
  if (!filtersRaw) return { ok: false, error: 'The job carries neither messageIds nor filters.' };

  const filters: MailSearchFilters = {
    folder: str(filtersRaw.folder) || undefined,
    ...(typeof filtersRaw.isRead === 'boolean' ? { isRead: filtersRaw.isRead } : {}),
    flagStatus: str(filtersRaw.flagStatus) || undefined,
    categories: strings(filtersRaw.categories),
    ...(typeof filtersRaw.hasAttachments === 'boolean'
      ? { hasAttachments: filtersRaw.hasAttachments }
      : {}),
    from: str(filtersRaw.from) || undefined,
    to: str(filtersRaw.to) || undefined,
    cc: str(filtersRaw.cc) || undefined,
    subjectContains: str(filtersRaw.subjectContains) || undefined,
    receivedAfter: str(filtersRaw.receivedAfter) || undefined,
    receivedBefore: str(filtersRaw.receivedBefore) || undefined,
  };
  const maxMessages = Math.min(
    typeof selection.maxMessages === 'number' && selection.maxMessages > 0
      ? selection.maxMessages
      : DEFAULT_JOB_MESSAGES,
    MAX_JOB_MESSAGES
  );

  const ids: string[] = [];
  // The $select has to carry whatever the client-side matcher reads, or a
  // filter this job was given silently matches nothing and the action runs
  // over the wrong set. clientSideSelect adds exactly those fields.
  let next: string | null = buildMailQueryPath(filters, {
    top: 100,
    select: clientSideSelect(filters, 'id,subject'),
  });
  for (let page = 0; page < EXPANSION_PAGE_BUDGET && next && ids.length < maxMessages; page += 1) {
    const result = await graphRequest(accessToken, next, { lane: 'background' });
    if (!result.ok) {
      return { ok: false, error: str(result.err.message) || 'Graph API error during selection' };
    }
    const body = isRecord(result.val) ? result.val : {};
    const rows = Array.isArray(body.value) ? body.value : [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = str(row.id);
      if (!id) continue;
      // subject/to/cc match client-side — Exchange cannot filter mail
      // subjects or recipient collections at all (see MailSearchFilters).
      // Shared with the interactive search on purpose: the two used to
      // carry separate copies of this rule, and a job whose copy fell
      // behind would select the wrong messages and then act on them.
      if (!matchesClientSide(row, filters)) continue;
      ids.push(id);
      if (ids.length >= maxMessages) break;
    }
    const nextLink = str(body['@odata.nextLink']);
    next = nextLink ? nextLink.replace(GRAPH_BASE_URL, '') : null;
  }
  return { ok: true, ids };
}

/** One action's batch requests over a set of message ids. */
function requestsFor(
  action: string,
  params: Record<string, unknown>,
  ids: readonly string[],
  categoriesFor?: (id: string) => string[]
): BatchRequestItem[] {
  switch (action) {
    case 'markRead':
      return ids.map((id) => ({
        id,
        method: 'PATCH' as const,
        url: `/me/messages/${encodeURIComponent(id)}`,
        body: { isRead: params.isRead !== false },
      }));
    case 'flag':
      return ids.map((id) => ({
        id,
        method: 'PATCH' as const,
        url: `/me/messages/${encodeURIComponent(id)}`,
        body: { flag: { flagStatus: str(params.flagStatus) || 'flagged' } },
      }));
    case 'categorize':
      return ids.map((id) => ({
        id,
        method: 'PATCH' as const,
        url: `/me/messages/${encodeURIComponent(id)}`,
        body: { categories: categoriesFor ? categoriesFor(id) : [] },
      }));
    case 'move':
    case 'archive':
      return ids.map((id) => ({
        id,
        method: 'POST' as const,
        url: `/me/messages/${encodeURIComponent(id)}/move`,
        body: {
          destinationId: str(params.destinationFolder) || (action === 'archive' ? 'archive' : ''),
        },
      }));
    default:
      return [];
  }
}

export function createMailBulkJobHandler(): EventHandler {
  return async (event) => {
    const payload: unknown = event.payload;
    const jobId = isRecord(payload) ? str(payload.jobId) : '';
    const tenantId = event.tenant_id;
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable for mail bulk job');
    const db = dbResult.val;

    const job = jobId
      ? await db
          .selectFrom('mail_bulk_jobs')
          .selectAll()
          .where('id', '=', jobId)
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst()
      : undefined;
    if (!job) {
      logger.warn('mail bulk job {jobId} not found; dropping', {
        component: COMPONENT,
        tenantId,
        jobId: jobId || '(missing)',
      });
      return;
    }

    if (job.status !== 'queued') {
      if (job.status === 'running') {
        // A previous delivery died mid-job. Do NOT re-execute — /move
        // returns new ids, a re-run double-acts. Finalize and stop.
        const succeeded = Number(job.succeeded ?? 0);
        await db
          .updateTable('mail_bulk_jobs')
          .set({
            status: succeeded > 0 ? 'partial' : 'failed',
            last_error: `worker restarted mid-job; ${succeeded} of ${job.total ?? '?'} had completed`,
            finished_at: sql`NOW()`,
            updated_at: sql`NOW()`,
          })
          .where('id', '=', job.id)
          .execute();
      }
      // Terminal (or just finalized): a redelivery is an idempotent no-op.
      return;
    }

    await db
      .updateTable('mail_bulk_jobs')
      .set({ status: 'running', started_at: sql`NOW()`, updated_at: sql`NOW()` })
      .where('id', '=', job.id)
      .execute();

    // From here nothing may throw: a throw would redeliver into the
    // running-guard above (harmless but noisy). Every failure lands on the
    // row instead.
    const fail = async (message: string, counts?: { succeeded: number; total: number | null }) => {
      await db
        .updateTable('mail_bulk_jobs')
        .set({
          status: counts && counts.succeeded > 0 ? 'partial' : 'failed',
          last_error: message,
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', job.id)
        .execute();
    };

    try {
      const access = await resolveMicrosoftAccess(tenantId, job.account_id);

      const selection = isRecord(job.selection) ? job.selection : {};
      const expanded = await expandSelection(access.accessToken, selection);
      if (!expanded.ok) {
        await fail(expanded.error);
        return;
      }
      const ids = expanded.ids;
      const params = isRecord(job.params) ? job.params : {};
      const action = job.action;

      await db
        .updateTable('mail_bulk_jobs')
        .set({ total: ids.length, updated_at: sql`NOW()` })
        .where('id', '=', job.id)
        .execute();
      if (ids.length === 0) {
        await db
          .updateTable('mail_bulk_jobs')
          .set({ status: 'succeeded', finished_at: sql`NOW()`, updated_at: sql`NOW()` })
          .where('id', '=', job.id)
          .execute();
        return;
      }

      let succeeded = 0;
      let failed = 0;
      const failures: JobFailure[] = [];
      const record = async (settled: readonly BatchResultItem[]) => {
        for (const item of settled) {
          if (item.ok) succeeded += 1;
          else {
            failed += 1;
            if (failures.length < FAILURES_KEPT) {
              failures.push({ id: item.id, error: item.error ?? 'unknown error' });
            }
          }
        }
        await db
          .updateTable('mail_bulk_jobs')
          .set({
            succeeded,
            failed,
            failures: JSON.stringify(failures),
            updated_at: sql`NOW()`,
          })
          .where('id', '=', job.id)
          .execute();
      };

      if (action === 'categorize') {
        // add/remove need each message's current categories first; replace
        // skips the read pass (the retired tool's exact two-pass shape).
        const add = strings(params.add);
        const remove = strings(params.remove);
        const replace = Array.isArray(params.replace) ? strings(params.replace) : null;
        let categoriesFor: (id: string) => string[];
        if (replace) {
          categoriesFor = () => replace;
        } else {
          const readBatch = await graphBatch(
            access.accessToken,
            ids.map((id) => ({
              id,
              method: 'GET' as const,
              url: `/me/messages/${encodeURIComponent(id)}?$select=categories`,
            })),
            { lane: 'background' }
          );
          const existingById = new Map<string, string[]>();
          for (const result of readBatch.results) {
            if (result.ok) existingById.set(result.id, strings(result.body?.categories));
          }
          categoriesFor = (id) => withCategoryChanges(existingById.get(id) ?? [], add, remove);
        }
        await graphBatch(access.accessToken, requestsFor(action, params, ids, categoriesFor), {
          lane: 'background',
          onChunk: record,
        });
      } else if (action === 'archive' && params.markRead !== false) {
        // Mark first, move second, and only move what the mark step actually
        // touched: /move returns a NEW message id in the destination folder,
        // so marking afterwards would need the post-move ids. A message
        // whose mark fails counts as failed and is not moved.
        const markBatch = await graphBatch(
          access.accessToken,
          requestsFor('markRead', { isRead: true }, ids),
          { lane: 'background' }
        );
        const readyToMove: string[] = [];
        for (const item of markBatch.results) {
          if (item.ok) readyToMove.push(item.id);
          else {
            failed += 1;
            if (failures.length < FAILURES_KEPT) {
              failures.push({ id: item.id, error: item.error ?? 'mark-read failed' });
            }
          }
        }
        await graphBatch(access.accessToken, requestsFor('archive', params, readyToMove), {
          lane: 'background',
          onChunk: record,
        });
      } else {
        const requests = requestsFor(action, params, ids);
        if (requests.length === 0) {
          await fail(`Unknown action "${action}".`);
          return;
        }
        await graphBatch(access.accessToken, requests, { lane: 'background', onChunk: record });
      }

      await db
        .updateTable('mail_bulk_jobs')
        .set({
          status: failed === 0 ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed',
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', job.id)
        .execute();
      logger.info('mail bulk job {jobId} finished: {succeeded} ok, {failed} failed', {
        component: COMPONENT,
        tenantId,
        jobId: job.id,
        action,
        succeeded,
        failed,
      });
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
    }
  };
}
