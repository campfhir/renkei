'use client';

/**
 * Who holds a grant on this share, and at what default level. People are
 * chosen from the org's known identities (passed from the server page) —
 * selection only, never a pasted subject identifier.
 *
 * Grants are also editable from the rules navigator's permissions panel
 * below; both surfaces announce mutations on GRANTS_CHANGED_EVENT and
 * reload on hearing it, so they stay in sync without a page refresh.
 */

import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson } from '@/lib/fetch-json';
import { inputClass } from '../share-config-fields';

/** Window event announcing a grant mutation on the current share page. */
export const GRANTS_CHANGED_EVENT = 'fileshare-grants-changed';

interface GrantRowView {
  subject: string;
  defaultAccess: 'none' | 'read' | 'read_write';
  createdAt: string;
}

const ACCESS_LABEL: Record<GrantRowView['defaultAccess'], string> = {
  none: 'specific folders only',
  read: 'read',
  read_write: 'read/write',
};

export default function GrantManager({
  slug,
  shareId,
  people,
}: {
  slug: string;
  shareId: string;
  people: { subject: string; label: string }[];
}) {
  const [grants, setGrants] = useState<GrantRowView[]>([]);
  const [subject, setSubject] = useState('');
  const [level, setLevel] = useState<GrantRowView['defaultAccess']>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ grants: GrantRowView[] }>(
      `/api/admin/${slug}/file-shares/${shareId}/grants`
    );
    if (loadError) setError(loadError);
    else setGrants(data?.grants ?? []);
  }, [slug, shareId]);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener(GRANTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(GRANTS_CHANGED_EVENT, onChanged);
  }, [load]);

  const labelFor = (grantSubject: string): string =>
    people.find((person) => person.subject === grantSubject)?.label ?? grantSubject;

  const save = async (grantSubject: string, defaultAccess: string) => {
    setBusy(true);
    setError(null);
    const saveError = await sendJson(`/api/admin/${slug}/file-shares/${shareId}/grants`, 'POST', {
      subject: grantSubject,
      defaultAccess,
    });
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setSubject('');
    window.dispatchEvent(new CustomEvent(GRANTS_CHANGED_EVENT));
  };

  const remove = async (grantSubject: string) => {
    if (!window.confirm(`Remove ${labelFor(grantSubject)}'s access (and their path rules)?`)) {
      return;
    }
    setBusy(true);
    setError(null);
    const removeError = await sendJson(
      `/api/admin/${slug}/file-shares/${shareId}/grants?subject=${encodeURIComponent(grantSubject)}`,
      'DELETE'
    );
    setBusy(false);
    if (removeError) {
      setError(removeError);
      return;
    }
    window.dispatchEvent(new CustomEvent(GRANTS_CHANGED_EVENT));
  };

  const known = new Set(grants.map((grant) => grant.subject));

  return (
    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
      {grants.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Nobody has access yet — this share is invisible to everyone but admins.
        </p>
      ) : (
        <ul className="space-y-2">
          {grants.map((grant) => (
            <li key={grant.subject} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{labelFor(grant.subject)}</p>
                <p className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                  {grant.subject}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  aria-label={`Default access for ${labelFor(grant.subject)}`}
                  className={inputClass}
                  value={grant.defaultAccess}
                  disabled={busy}
                  onChange={(event) => void save(grant.subject, event.target.value)}
                >
                  <option value="none">{ACCESS_LABEL.none}</option>
                  <option value="read">{ACCESS_LABEL.read}</option>
                  <option value="read_write">{ACCESS_LABEL.read_write}</option>
                </select>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(grant.subject)}
                  className="text-sm text-red-600 hover:underline dark:text-red-400"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
        <select
          aria-label="Person to grant"
          className={inputClass}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        >
          <option value="">Pick a person…</option>
          {people
            .filter((person) => !known.has(person.subject))
            .map((person) => (
              <option key={person.subject} value={person.subject}>
                {person.label}
              </option>
            ))}
        </select>
        <select
          aria-label="Default access"
          className={inputClass}
          value={level}
          onChange={(event) =>
            setLevel(
              event.target.value === 'read_write'
                ? 'read_write'
                : event.target.value === 'none'
                  ? 'none'
                  : 'read'
            )
          }
        >
          <option value="none">{ACCESS_LABEL.none}</option>
          <option value="read">{ACCESS_LABEL.read}</option>
          <option value="read_write">{ACCESS_LABEL.read_write}</option>
        </select>
        <button
          type="button"
          disabled={busy || !subject}
          onClick={() => void save(subject, level)}
          className="text-sm font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
        >
          + Grant access
        </button>
      </div>

      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
