'use client';

/**
 * The sign-in claim mappings, editable in place: which claim carries
 * roles, which values make an operator or a user, and — for connector
 * audiences — which claim carries groups. Nothing here touches the client
 * secret or the issuer; those were set when the organization was created.
 */

import { useState, type FormEvent } from 'react';

export interface IdentityClaimsValues {
  roleClaim: string;
  operatorIdpValue: string;
  userIdpValue: string;
  groupsClaim: string;
}

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

export default function IdentityForm({
  slug,
  initial,
  observedGroups,
}: {
  slug: string;
  initial: IdentityClaimsValues;
  /** How many distinct group values sign-ins have recorded so far. */
  observedGroups: number;
}) {
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof IdentityClaimsValues>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch(`/api/admin/${slug}/oidc-claims`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          typeof body === 'object' && body !== null && 'error' in body
            ? String(body.error)
            : 'Could not save'
        );
        return;
      }
      setNotice('Saved. Applies at each person’s next sign-in.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="roleClaim">
            Role claim
          </label>
          <input
            id="roleClaim"
            className={inputClass}
            value={values.roleClaim}
            onChange={(event) => update('roleClaim', event.target.value)}
            placeholder="roles"
          />
          <p className={hintClass}>The id_token claim whose values decide operator and user.</p>
        </div>
        <div>
          <label className={labelClass} htmlFor="groupsClaim">
            Groups claim
          </label>
          <input
            id="groupsClaim"
            className={inputClass}
            value={values.groupsClaim}
            onChange={(event) => update('groupsClaim', event.target.value)}
            placeholder="groups"
          />
          <p className={hintClass}>
            Recorded at sign-in for connector audiences. {observedGroups} distinct value
            {observedGroups === 1 ? '' : 's'} seen so far. Entra omits the claim for people in more
            than ~200 groups; they then count as in no group.
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor="operatorIdpValue">
            Operator value
          </label>
          <input
            id="operatorIdpValue"
            className={inputClass}
            value={values.operatorIdpValue}
            onChange={(event) => update('operatorIdpValue', event.target.value)}
            placeholder="e.g. platform-admin"
          />
          <p className={hintClass}>A role-claim value that grants renkei-operator.</p>
        </div>
        <div>
          <label className={labelClass} htmlFor="userIdpValue">
            User value
          </label>
          <input
            id="userIdpValue"
            className={inputClass}
            value={values.userIdpValue}
            onChange={(event) => update('userIdpValue', event.target.value)}
            placeholder="e.g. member"
          />
          <p className={hintClass}>A role-claim value that grants renkei-user.</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
        >
          {busy ? 'Saving…' : 'Save claims'}
        </button>
        {notice && <span className="text-sm text-green-700 dark:text-green-400">{notice}</span>}
        {error && <span className="text-sm text-red-700 dark:text-red-400">{error}</span>}
      </div>
    </form>
  );
}
