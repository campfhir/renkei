'use client';

/**
 * The checkout's size limit on a code project's page, and the way to ask
 * for more: a gigabyte figure and a reason go to an admin, who approves
 * or denies it from Admin → Settings. An approval raises this project's
 * limit only. While a request waits the form is replaced by its state —
 * one open ask per project. What it decides is size-request.model.ts.
 */

import { useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import Modal from '@/components/modal';
import type { CodeProjectView } from '@/lib/code/project-view';
import {
  MAX_GB,
  canSend,
  dialogShown,
  gbText,
  initSizeRequest,
  minWantedGb,
  requestBody,
  requestLine,
  sendLabel,
  sizeRequestReducer,
} from './size-request.model';

const inputClass =
  'rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900';

export default function SizeRequest({
  projectId,
  limitBytes,
  request,
}: {
  projectId: string;
  limitBytes: number;
  request: CodeProjectView['code']['sizeRequest'];
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(sizeRequestReducer, limitBytes, initSizeRequest);

  async function submit() {
    dispatch({ type: 'sent' });
    const result = await sendJsonFull(
      `/api/code/projects/${projectId}/size-request`,
      'POST',
      requestBody(state)
    );
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'accepted' });
    router.refresh();
  }

  const line = requestLine(request);

  return (
    <div className="mt-1 text-xs text-gray-500" data-testid="size-request">
      <span data-testid="size-limit">Checkout limit {gbText(limitBytes)}.</span>{' '}
      {line.kind === 'pending' ? (
        <span data-testid="size-request-pending">{line.text}</span>
      ) : (
        <>
          {line.kind === 'decided' ? (
            <span data-testid="size-request-last">{line.text} </span>
          ) : null}
          <button
            type="button"
            onClick={() => dispatch({ type: 'opened' })}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Ask for more space
          </button>
        </>
      )}
      {dialogShown(state, request) && (
        <Modal title="Ask for more space" onClose={() => dispatch({ type: 'closed' })}>
          <p className="mb-3 text-xs text-gray-500">
            This project’s checkout may grow to {gbText(limitBytes)}. Ask for more and an admin will
            approve or deny it; an approval raises this project only.
          </p>
          <div className="space-y-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs">Size wanted (GB)</span>
              <input
                type="number"
                aria-label="Size wanted (GB)"
                min={minWantedGb(limitBytes)}
                max={MAX_GB}
                value={state.wanted}
                onChange={(event) =>
                  dispatch({ type: 'wantedChanged', gb: Number(event.target.value) })
                }
                className={`${inputClass} w-28`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs">Why you need it</span>
              <textarea
                aria-label="Why you need it"
                rows={3}
                maxLength={1000}
                value={state.reason}
                onChange={(event) =>
                  dispatch({ type: 'reasonChanged', reason: event.target.value })
                }
                className={`${inputClass} w-full`}
              />
            </label>
            {state.error && <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => dispatch({ type: 'closed' })}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSend(state)}
                onClick={() => void submit()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {sendLabel(state)}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
