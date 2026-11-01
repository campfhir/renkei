'use client';

/**
 * Requests for larger code-workspace checkouts, awaiting an admin.
 * Approving raises that project's limit (the amount asked for, or an
 * amount the admin sets); denying can carry a note the person sees. What
 * the list decides is size-requests.model.ts.
 */

import { useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import type { SizeRequestView } from '@/lib/code/size-requests';
import {
  decidedLine,
  decisionBody,
  gbText,
  initRow,
  partitionRequests,
  rowReducer,
} from './size-requests.model';

function Row({ item }: { item: SizeRequestView }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(rowReducer, item.requestedBytes, initRow);

  async function decide(decision: 'approved' | 'denied') {
    dispatch({ type: 'sent' });
    const result = await sendJsonFull(
      `/api/admin/sandbox-size-requests/${item.id}`,
      'POST',
      decisionBody(state, decision)
    );
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'decided' });
    router.refresh();
  }

  return (
    <li
      className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
      data-testid="size-request-row"
    >
      <p className="text-sm">
        <span className="font-medium">{item.projectName}</span> — asks for{' '}
        <span className="font-medium">{gbText(item.requestedBytes)}</span>
      </p>
      <p className="mt-0.5 text-xs text-gray-500">{item.reason}</p>
      <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span>Approve up to (GB)</span>
          <input
            type="number"
            aria-label="Approve up to (GB)"
            min={1}
            max={64}
            value={state.approveGb}
            onChange={(event) =>
              dispatch({ type: 'approveGbChanged', gb: Number(event.target.value) })
            }
            className="w-24 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span>Note (optional)</span>
          <input
            type="text"
            aria-label="Note"
            maxLength={1000}
            value={state.note}
            onChange={(event) => dispatch({ type: 'noteChanged', note: event.target.value })}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </label>
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void decide('approved')}
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void decide('denied')}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-gray-700"
        >
          Deny
        </button>
      </div>
      {state.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{state.error}</p>}
    </li>
  );
}

export function SizeRequests({ requests }: { requests: SizeRequestView[] }) {
  const { pending, decided } = partitionRequests(requests);
  return (
    <section
      className="mt-4 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-800 dark:bg-gray-950"
      data-testid="size-requests"
    >
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Checkout size requests
      </h2>
      {pending.length === 0 ? (
        <p className="text-gray-600 dark:text-gray-400">No requests waiting.</p>
      ) : (
        <ul className="space-y-2">
          {pending.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <>
          <h3 className="mt-4 mb-1 text-xs font-semibold text-gray-500">Recently decided</h3>
          <ul className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
            {decided.map((item) => (
              <li key={item.id}>{decidedLine(item)}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
