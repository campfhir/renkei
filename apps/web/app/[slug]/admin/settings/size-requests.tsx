'use client';

/**
 * Requests for larger code-workspace checkouts, awaiting an admin.
 * Approving raises that project's limit (the amount asked for, or an
 * amount the admin sets); denying can carry a note the person sees.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import type { SizeRequestView } from '@/lib/code/size-requests';

const GB = 1_073_741_824;

function gb(value: number): string {
  const n = value / GB;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} GB`;
}

function Row({ slug, item }: { slug: string; item: SizeRequestView }) {
  const router = useRouter();
  const [approveGb, setApproveGb] = useState(Math.round(item.requestedBytes / GB));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approved' | 'denied') {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull(
      `/api/admin/${slug}/sandbox-size-requests/${item.id}`,
      'POST',
      decision === 'approved'
        ? { decision, note, approvedBytes: approveGb * GB }
        : { decision, note }
    );
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <li
      className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
      data-testid="size-request-row"
    >
      <p className="text-sm">
        <span className="font-medium">{item.projectName}</span> — asks for{' '}
        <span className="font-medium">{gb(item.requestedBytes)}</span>
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
            value={approveGb}
            onChange={(event) => setApproveGb(Number(event.target.value))}
            className="w-24 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span>Note (optional)</span>
          <input
            type="text"
            aria-label="Note"
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('approved')}
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('denied')}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-gray-700"
        >
          Deny
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </li>
  );
}

export function SizeRequests({ slug, requests }: { slug: string; requests: SizeRequestView[] }) {
  const pending = requests.filter((request) => request.status === 'pending');
  const decided = requests.filter((request) => request.status !== 'pending').slice(0, 10);
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
            <Row key={item.id} slug={slug} item={item} />
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <>
          <h3 className="mt-4 mb-1 text-xs font-semibold text-gray-500">Recently decided</h3>
          <ul className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
            {decided.map((item) => (
              <li key={item.id}>
                {item.projectName} — {gb(item.requestedBytes)} {item.status}
                {item.decisionNote ? ` (${item.decisionNote})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
