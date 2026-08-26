'use client';

/**
 * The grant dialog both surfaces share (the Access section's button and
 * the permissions panel's "+ Add user"): search the org's people, build a
 * set of them, pick one default level for the whole set, and grant them
 * all at once. The caller passes only ungranted people and hears back via
 * onDone after every grant is written.
 */

import { useState } from 'react';
import { sendJson } from '@/lib/fetch-json';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { inputClass } from '../share-config-fields';
import { AccessCheckboxes, type AccessLevelView } from './access-checkboxes';

const RESULT_LIMIT = 8;

export default function GrantAccessModal({
  slug,
  shareId,
  ceiling,
  people,
  onDone,
  onClose,
}: {
  slug: string;
  shareId: string;
  ceiling: 'read' | 'read_write';
  /** Only people without a grant on this share. */
  people: { subject: string; label: string }[];
  /** Called after grants are written (even partially), before closing. */
  onDone: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ subject: string; label: string }[]>([]);
  const [level, setLevel] = useState<AccessLevelView>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickedSubjects = new Set(picked.map((person) => person.subject));
  const needle = query.trim().toLowerCase();
  const matches = people
    .filter((person) => !pickedSubjects.has(person.subject))
    .filter(
      (person) =>
        needle === '' ||
        person.label.toLowerCase().includes(needle) ||
        person.subject.toLowerCase().includes(needle)
    )
    .slice(0, RESULT_LIMIT);

  const grantAll = async () => {
    setBusy(true);
    setError(null);
    let granted = 0;
    for (const person of picked) {
      const saveError = await sendJson(`/api/admin/${slug}/file-shares/${shareId}/grants`, 'POST', {
        subject: person.subject,
        defaultAccess: level,
      });
      if (saveError) {
        setBusy(false);
        setError(`${person.label}: ${saveError}`);
        // Drop the ones already granted so a retry doesn't double-post.
        setPicked((current) => current.slice(granted));
        if (granted > 0) onDone();
        return;
      }
      granted += 1;
    }
    setBusy(false);
    onDone();
    onClose();
  };

  return (
    <Modal title="Grant access" onClose={onClose}>
      <div className="space-y-3 text-sm">
        {picked.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {picked.map((person) => (
              <li
                key={person.subject}
                className="flex items-center gap-1 rounded-full bg-blue-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
              >
                {person.label}
                <button
                  type="button"
                  aria-label={`Remove ${person.label}`}
                  disabled={busy}
                  onClick={() =>
                    setPicked((current) =>
                      current.filter((entry) => entry.subject !== person.subject)
                    )
                  }
                  className="rounded-full p-0.5 hover:bg-blue-100 dark:hover:bg-blue-900/50"
                >
                  <Icon path={ICONS.close} className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div>
          <label className="mb-1 block text-gray-600 dark:text-gray-400" htmlFor="grant-search">
            Add people
          </label>
          <input
            id="grant-search"
            autoFocus
            type="text"
            placeholder="Search people…"
            className={`${inputClass} w-full`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {people.length === 0 ? (
            <p className="mt-2 text-gray-500 dark:text-gray-400">
              Everyone the org knows about already has access to this share.
            </p>
          ) : matches.length === 0 ? (
            <p className="mt-2 text-gray-500 dark:text-gray-400">
              {picked.length === people.length ? 'Everyone matching is picked.' : 'No one matches.'}
            </p>
          ) : (
            <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-800">
              {matches.map((person) => (
                <li key={person.subject}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPicked((current) => [...current, person]);
                      setQuery('');
                    }}
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{person.label}</span>
                      <span className="block truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                        {person.subject}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-blue-600 dark:text-blue-400">Add</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <span className="mb-1 block text-gray-600 dark:text-gray-400">
            Access across the share
          </span>
          <div className="flex items-center gap-3">
            <AccessCheckboxes
              name="Access for picked people"
              level={level}
              ceiling={ceiling}
              onLevel={setLevel}
            />
            {level === 'none' ? (
              <span className="text-xs text-gray-400 dark:text-gray-500">
                specific folders only — set folders under Permissions
              </span>
            ) : null}
          </div>
        </div>

        {error ? <p className="text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-900"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={picked.length === 0 || busy}
            onClick={() => void grantAll()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy
              ? 'Granting…'
              : picked.length > 1
                ? `Grant access to ${picked.length} people`
                : 'Grant access'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
