'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';

/**
 * The owner's sharing control, opened from the overview header's Share
 * button. Two independent things live here:
 *
 *   1. The copy link — mint it, show it (re-displayable — that's why the
 *      token is stored, not digested), regenerate to invalidate what's out
 *      there, or stop sharing. The link only works for people signed into
 *      this same organization, and only lets them COPY the agent.
 *   2. People with access — named colleagues granted the owner's own view
 *      of THIS agent (run details, edit) for troubleshooting, each with an
 *      optional expiry, revocable by deleting the row.
 */

interface GrantRow {
  id: string;
  granteeSubject: string;
  granteeName: string | null;
  granteeEmail: string | null;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
}

interface Person {
  subject: string;
  email: string;
  displayName: string | null;
}

const EXPIRY_CHOICES = [
  { value: 'none', label: 'No expiry' },
  { value: '1', label: 'Expires in 1 day' },
  { value: '7', label: 'Expires in 7 days' },
  { value: '30', label: 'Expires in 30 days' },
] as const;

function expiryToIso(choice: string): string | null {
  const days = Number(choice);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function personLabel(person: { displayName?: string | null; email?: string | null }): string {
  return person.displayName
    ? `${person.displayName} (${person.email ?? '?'})`
    : (person.email ?? '?');
}

/**
 * The "People with access" half of the modal: pick a colleague, pick how
 * long, grant; the list below shows who has access now (lapsed grants stay
 * visible, marked, until deleted) and revokes by deleting the entry.
 */
function PeopleWithAccess({ tenantId, agentId }: { tenantId: string; agentId: string }) {
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [pickedSubject, setPickedSubject] = useState('');
  const [expiry, setExpiry] = useState<string>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/tenant/${tenantId}/agents/${agentId}/access`);
    const body: { grants?: GrantRow[]; people?: Person[]; error?: string } = await response
      .json()
      .catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? 'The access list could not be loaded');
      return;
    }
    setGrants(body.grants ?? []);
    setPeople(body.people ?? []);
  }, [tenantId, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grant = async () => {
    if (!pickedSubject) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/agents/${agentId}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ granteeSubject: pickedSubject, expiresAt: expiryToIso(expiry) }),
      });
      const body: { grants?: GrantRow[]; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? 'Access could not be granted');
        return;
      }
      setGrants(body.grants ?? []);
      setPickedSubject('');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grantId: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/agents/${agentId}/access/${grantId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const body: { error?: string } = await response.json().catch(() => ({}));
        setError(body.error ?? 'The grant could not be revoked');
        return;
      }
      setGrants((current) => (current ?? []).filter((row) => row.id !== grantId));
    } finally {
      setBusy(false);
    }
  };

  const grantedSubjects = new Set((grants ?? []).map((row) => row.granteeSubject));
  const pickablePeople = people.filter((person) => !grantedSubjects.has(person.subject));

  return (
    <div className="mt-4 border-t border-gray-200 pt-4 text-sm dark:border-gray-800">
      <h3 className="font-semibold">People with access</h3>
      <p className="mt-1 text-gray-600 dark:text-gray-400">
        Give a colleague your own view of this agent for troubleshooting — full run details and
        editing included. You&apos;ll be notified when they change it (switch that off under
        Preferences → Notifications), and every change lands in the audit trail.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          aria-label="Colleague to share with"
          value={pickedSubject}
          onChange={(event) => setPickedSubject(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-950"
        >
          <option value="">Choose a colleague…</option>
          {pickablePeople.map((person) => (
            <option key={person.subject} value={person.subject}>
              {personLabel(person)}
            </option>
          ))}
        </select>
        <select
          aria-label="Access expiry"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          className="rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-950"
        >
          {EXPIRY_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !pickedSubject}
          onClick={() => void grant()}
          className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Grant access
        </button>
      </div>

      {grants === null ? (
        <p className="mt-3 text-gray-500 dark:text-gray-400">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="mt-3 text-gray-500 dark:text-gray-400">Nobody has access right now.</p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-900">
          {grants.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate">
                  {personLabel({ displayName: row.granteeName, email: row.granteeEmail })}
                </span>
                <span
                  className={`block text-xs ${
                    row.expired
                      ? 'font-medium text-amber-600 dark:text-amber-400'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {row.expired
                    ? 'Expired — access has lapsed'
                    : row.expiresAt
                      ? `Until ${new Date(row.expiresAt).toLocaleString()}`
                      : 'Open-ended'}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Revoke access for ${row.granteeEmail ?? row.granteeSubject}`}
                disabled={busy}
                onClick={() => void revoke(row.id)}
                className="shrink-0 rounded-md p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                <Icon path={ICONS.trash} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="mt-2 text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
export default function ShareAgentButton({
  slug,
  tenantId,
  agentId,
  initialToken,
}: {
  slug: string;
  tenantId: string;
  agentId: string;
  initialToken: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const shareUrl = token
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/${slug}/agents/shared/${token}`
    : null;

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/agents/${agentId}/share`, {
        method: 'POST',
      });
      const body: { token?: string; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok || !body.token) {
        setError(body.error ?? 'Sharing could not be enabled');
        return;
      }
      setToken(body.token);
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/tenant/${tenantId}/agents/${agentId}/share`, { method: 'DELETE' });
      setToken(null);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setError('Could not reach the clipboard — copy the link text by hand');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
      >
        <Icon path={ICONS.share} />
        Share
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Share this agent"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Sharing</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <Icon path={ICONS.close} />
              </button>
            </div>

            {token ? (
              <div className="text-sm">
                <p className="text-gray-600 dark:text-gray-400">
                  Anyone signed into this organization with the link can copy this agent&apos;s
                  configuration — knowledge notes included — and make it their own. Copies run on
                  THEIR connections and start switched off; your agent and its memory stay yours.
                </p>
                <p className="my-2 break-all rounded-md bg-gray-50 p-2 text-xs dark:bg-gray-900">
                  {shareUrl}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyLink()}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    {copied ? 'Copied!' : 'Copy link'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void mint()}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
                  >
                    Regenerate (invalidates the old link)
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void stop()}
                    className="text-sm text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                  >
                    Stop sharing
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-sm">
                <p className="mb-3 text-gray-600 dark:text-gray-400">
                  Create a link that lets colleagues in this organization copy this agent as a
                  starting point of their own. Nothing is shared until you create it.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void mint()}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Share this agent (create a copy link)
                </button>
              </div>
            )}
            {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
            <PeopleWithAccess tenantId={tenantId} agentId={agentId} />
          </div>
        </div>
      ) : null}
    </>
  );
}
