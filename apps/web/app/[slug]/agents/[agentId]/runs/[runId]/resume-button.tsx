'use client';

/**
 * "Resume from the failed step" on a FAILED run: the same run, its same
 * snapshot and saved results, picked back up at the step that stopped it
 * with that step's attempts set aside — plus a line from the person on
 * what to do differently, which that step's next attempt reads as
 * binding guidance ("the CIO project has no Task issue type — file it as
 * a Project").
 *
 * Sits beside "Run again with current steps", and the two answer
 * different questions: rerun is for when the PLAN was wrong (you edited
 * the steps and want the same input put back through), resume is for
 * when the plan was fine and one step needs another go. The note field
 * is the whole point of offering resume rather than a bare retry — a
 * failure the owner can read is usually a failure they can explain.
 *
 * Stays on THIS run's page: the run row is the one that changes, and
 * the page's live stream picks the change up from there.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { resumeAgentRun } from '@/lib/agents/invoke-client';
import ConfirmRunModal from '../../../confirm-run-modal';

const GUIDANCE_MAX = 2_000;

export default function ResumeButton({
  tenantId,
  agentId,
  runId,
  agentName,
  failedStepName,
}: {
  tenantId: string;
  agentId: string;
  runId: string;
  agentName: string;
  failedStepName: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);

  const resume = async (confirm = false) => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    const result = await resumeAgentRun(tenantId, agentId, runId, guidance, confirm);
    setBusy(false);
    switch (result.kind) {
      case 'needs-confirm':
        setConfirmMessage(result.message);
        return;
      case 'error':
        setConfirmMessage(null);
        setError(result.message);
        return;
      case 'started':
        setConfirmMessage(null);
        setDone(true);
        setOpen(false);
        router.refresh();
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy || done}
        title={
          failedStepName
            ? `Pick this run back up at “${failedStepName}” — same run, same saved results, a fresh try for that step`
            : 'Pick this run back up where it stopped'
        }
        className="rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 hover:border-blue-500 hover:text-blue-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-blue-400 dark:hover:text-blue-300"
      >
        {done ? 'Resuming…' : '↺ Resume from the failed step'}
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      {open && !done ? (
        <div className="basis-full rounded-lg border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-800 dark:bg-gray-900/40">
          <p className="mb-2 text-sm text-gray-700 dark:text-gray-300">
            {failedStepName ? (
              <>
                The run continues at <span className="font-medium">“{failedStepName}”</span> with
                that step’s failed attempts set aside. Everything earlier steps saved is kept.
              </>
            ) : (
              <>The run continues from where it stopped, keeping what earlier steps saved.</>
            )}
          </p>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">
            What should it do differently this time? (optional)
            <textarea
              value={guidance}
              onChange={(event) => setGuidance(event.target.value.slice(0, GUIDANCE_MAX))}
              rows={3}
              placeholder="e.g. The CIO project has no “Task” issue type — create it as a “Project” instead."
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            />
          </label>
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-gray-500">
              {guidance.length > 0 ? `${guidance.length} / ${GUIDANCE_MAX}` : ''}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="rounded-md border border-gray-300 px-3 py-1 text-xs disabled:opacity-50 dark:border-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void resume()}
              disabled={busy}
              className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Resuming…' : 'Resume run'}
            </button>
          </div>
        </div>
      ) : null}
      {confirmMessage ? (
        <ConfirmRunModal
          agentName={agentName}
          message={confirmMessage}
          busy={busy}
          onCancel={() => setConfirmMessage(null)}
          onConfirm={() => void resume(true)}
        />
      ) : null}
    </>
  );
}
