'use client';

/**
 * Apply and Cancel on a change request's review page — the click the
 * confirm rule is about. Both post to session-only routes that act on the
 * stored request by id; nothing about the change itself travels from here.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ChangeActions({
  tenantId,
  changeId,
  count,
  applyBlocked,
}: {
  tenantId: string;
  changeId: string;
  /** How many operations, for the button's label. */
  count: number;
  /** Why applying is refused right now (read-only mode, not connected…); null when it is not. */
  applyBlocked: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'apply' | 'cancel' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(action: 'apply' | 'cancel') {
    setBusy(action);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/tenant/${tenantId}/jira-admin/changes/${changeId}/${action}`,
        { method: 'POST' }
      );
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const body: Record<string, unknown> =
          typeof data === 'object' && data !== null ? Object.fromEntries(Object.entries(data)) : {};
        setNotice(
          typeof body.error === 'string' && body.error
            ? body.error
            : action === 'apply'
              ? 'Could not apply the change'
              : 'Could not cancel the change'
        );
        return;
      }
      router.refresh();
    } catch {
      setNotice('Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6">
      {applyBlocked && (
        <p className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {applyBlocked}
        </p>
      )}
      {notice && (
        <p
          role="alert"
          className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
        >
          {notice}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => void act('apply')}
          disabled={busy !== null || applyBlocked !== null}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy === 'apply'
            ? 'Applying…'
            : count === 1
              ? 'Apply this change to Jira'
              : `Apply these ${count} changes to Jira`}
        </button>
        <button
          onClick={() => void act('cancel')}
          disabled={busy !== null}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel it'}
        </button>
      </div>
    </div>
  );
}
