'use client';

/**
 * The checkout's size limit on a code project's page, and the way to ask
 * for more: a gigabyte figure and a reason go to an admin, who approves
 * or denies it from Admin → Settings. An approval raises this project's
 * limit only. While a request waits the form is replaced by its state —
 * one open ask per project.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import Modal from '@/components/modal';
import type { CodeProjectView } from '@/lib/code/project-view';

const GB = 1_073_741_824;
const MAX_GB = 64;
const inputClass =
  'rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900';

function gb(value: number): string {
  const n = value / GB;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;
}

export default function SizeRequest({
  tenantId,
  projectId,
  limitBytes,
  request,
}: {
  tenantId: string;
  projectId: string;
  limitBytes: number;
  request: CodeProjectView['code']['sizeRequest'];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(Math.min(MAX_GB, Math.round(limitBytes / GB) * 2));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull(
      `/api/tenant/${tenantId}/code/projects/${projectId}/size-request`,
      'POST',
      { requestedBytes: wanted * GB, reason }
    );
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setReason('');
    router.refresh();
  }

  const pending = request?.status === 'pending' ? request : null;
  const last = request && request.status !== 'pending' ? request : null;

  return (
    <div className="mt-1 text-xs text-gray-500" data-testid="size-request">
      <span data-testid="size-limit">Checkout limit {gb(limitBytes)}.</span>{' '}
      {pending ? (
        <span data-testid="size-request-pending">
          Your request for {gb(pending.requestedBytes)} is waiting for an admin.
        </span>
      ) : (
        <>
          {last ? (
            <span data-testid="size-request-last">
              {last.status === 'approved'
                ? `Your request for ${gb(last.requestedBytes)} was approved.`
                : `Your last request was denied${last.decisionNote ? `: ${last.decisionNote}` : '.'}`}{' '}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Ask for more space
          </button>
        </>
      )}
      {open && !pending && (
        <Modal title="Ask for more space" onClose={() => setOpen(false)}>
          <p className="mb-3 text-xs text-gray-500">
            This project’s checkout may grow to {gb(limitBytes)}. Ask for more and an admin will
            approve or deny it; an approval raises this project only.
          </p>
          <div className="space-y-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs">Size wanted (GB)</span>
              <input
                type="number"
                aria-label="Size wanted (GB)"
                min={Math.floor(limitBytes / GB) + 1}
                max={MAX_GB}
                value={wanted}
                onChange={(event) => setWanted(Number(event.target.value))}
                className={`${inputClass} w-28`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs">Why you need it</span>
              <textarea
                aria-label="Why you need it"
                rows={3}
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className={`${inputClass} w-full`}
              />
            </label>
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || reason.trim().length === 0}
                onClick={() => void submit()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
