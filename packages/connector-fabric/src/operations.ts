/**
 * Fabric operations as Renkei keeps them (`getDataStore().fabricOperations`):
 * starting a definition fetch, and moving a running one along.
 *
 * Starting asks Fabric for the definition. Fabric either answers with it
 * (the row is written finished) or answers 202 with an operation to poll
 * (the row is written running, due when Fabric's `Retry-After` says).
 * Advancing is one look at Fabric for one row whose lease the caller
 * holds: still running moves `nextPollAt` on; an end is written with
 * `finish`, which only one caller can win, so whoever sees `finished`
 * true is the one who reports it.
 *
 * Who advances: the web app's event stream while the person's browser
 * watches (`advanceIfDue`), and the worker's sweep for the rows nobody
 * watches (`claimDue` then `advanceOperation`). Both take the lease first,
 * so Fabric is never asked about one operation twice at once.
 */

import { getDataStore, type FabricOperationKind, type FabricOperationRecord } from '@renkei/db';
import { decodeDefinition, fabricRequest, pollOperation, type FabricFetch } from './api';

/** How long a poller holds a row while it asks Fabric (two calls, 30 s each at most). */
export const LEASE_SECONDS = 90;

/** The collection a definition kind lives under in Fabric's URLs. */
const COLLECTION: Record<FabricOperationKind, string> = {
  'notebook-definition': 'notebooks',
  'pipeline-definition': 'dataPipelines',
};

/** What a person calls the thing a kind fetches. */
export function kindLabel(kind: FabricOperationKind): string {
  return kind === 'notebook-definition' ? 'notebook' : 'data pipeline';
}

const later = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

export interface StartDefinition {
  id: string;
  subject: string;
  kind: FabricOperationKind;
  workspaceId: string;
  workspaceName: string;
  itemId: string;
  itemName: string;
  /** `ipynb` for a notebook as Jupyter; null for Fabric's default format. */
  format: string | null;
  fetcher: FabricFetch;
  base: string;
  now: Date;
}

/**
 * Ask Fabric for a definition and record the wait. A refusal before Fabric
 * started anything (403, 404) writes no row: it comes back as the reason.
 */
export async function startDefinitionOperation(
  start: StartDefinition
): Promise<{ ok: true; operation: FabricOperationRecord } | { ok: false; error: string }> {
  const query = start.format ? `?format=${encodeURIComponent(start.format)}` : '';
  const path =
    `/workspaces/${encodeURIComponent(start.workspaceId)}/${COLLECTION[start.kind]}/` +
    `${encodeURIComponent(start.itemId)}/getDefinition${query}`;
  const answer = await fabricRequest(start.fetcher, start.base, 'POST', path);
  if (!answer.ok) return { ok: false, error: answer.error };

  const base = {
    id: start.id,
    subject: start.subject,
    kind: start.kind,
    workspaceId: start.workspaceId,
    workspaceName: start.workspaceName,
    itemId: start.itemId,
    itemName: start.itemName,
    format: start.format,
    createdAt: start.now,
  };
  const store = getDataStore().fabricOperations;
  if (answer.pending) {
    return {
      ok: true,
      operation: await store.insert({
        ...base,
        status: 'running',
        operationId: answer.pending.operationId,
        percentComplete: null,
        result: null,
        error: null,
        nextPollAt: later(start.now, answer.pending.retryAfterSeconds),
        finishedAt: null,
      }),
    };
  }
  const decoded = decodeDefinition(answer.body);
  const failed = typeof decoded === 'string';
  return {
    ok: true,
    operation: await store.insert({
      ...base,
      status: failed ? 'failed' : 'succeeded',
      operationId: null,
      percentComplete: failed ? null : 100,
      result: failed ? null : decoded,
      error: failed ? decoded : null,
      nextPollAt: null,
      finishedAt: start.now,
    }),
  };
}

export interface Advanced {
  /** The row as it stands after this look; null when it went from under us. */
  operation: FabricOperationRecord | null;
  /** True only for the call that wrote the end. */
  finished: boolean;
}

/** One look at Fabric for a row whose lease the caller holds. */
export async function advanceOperation(
  operation: FabricOperationRecord,
  fetcher: FabricFetch,
  base: string,
  now: Date
): Promise<Advanced> {
  const store = getDataStore().fabricOperations;
  const end = async (outcome: Parameters<typeof store.finish>[1]): Promise<Advanced> => {
    const finished = await store.finish(operation.id, outcome, now);
    return finished
      ? { operation: finished, finished: true }
      : { operation: await store.find(operation.subject, operation.id), finished: false };
  };

  if (!operation.operationId) {
    return end({ status: 'failed', result: null, error: 'Fabric gave no operation to follow.' });
  }
  const state = await pollOperation(fetcher, base, operation.operationId, true);
  if (state.state === 'running') {
    const moved = await store.progress(
      operation.id,
      { percentComplete: state.percentComplete, nextPollAt: later(now, state.retryAfterSeconds) },
      now
    );
    return {
      operation: moved ?? (await store.find(operation.subject, operation.id)),
      finished: false,
    };
  }
  if (state.state === 'failed') return end({ status: 'failed', result: null, error: state.error });
  const decoded = state.result
    ? decodeDefinition(state.result)
    : 'Fabric finished without a result.';
  return typeof decoded === 'string'
    ? end({ status: 'failed', result: null, error: decoded })
    : end({ status: 'succeeded', result: decoded, error: null });
}

/**
 * Advance one operation if it is due and nobody else holds it — what a
 * watching browser's stream calls on each tick. Null when there was
 * nothing to do (not due, held, or no longer running).
 */
export async function advanceIfDue(
  id: string,
  fetcher: FabricFetch,
  base: string,
  now: Date
): Promise<Advanced | null> {
  const claimed = await getDataStore().fabricOperations.claim(id, now, later(now, LEASE_SECONDS));
  return claimed ? advanceOperation(claimed, fetcher, base, now) : null;
}
