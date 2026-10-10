'use client';

/**
 * The "Run now" button's own guard: a run of this agent is already queued
 * or running, so a second click needs a beat before it queues another one
 * behind it. Shared by the agents list and the agent detail page's Run now
 * button — both call invokeAgentRun and open this on `needs-confirm`.
 */

import Modal from '@/components/modal';

export default function ConfirmRunModal({
  agentName,
  message,
  busy,
  onConfirm,
  onCancel,
}: {
  agentName: string;
  message: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title="Run already in progress" onClose={onCancel}>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {message} Queuing another run of &ldquo;{agentName}&rdquo; now means two runs of it in
        flight — the new one waits and starts once the current one finishes.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-gray-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Queuing…' : 'Queue anyway'}
        </button>
      </div>
    </Modal>
  );
}
