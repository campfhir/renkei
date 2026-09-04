'use client';

/**
 * One sharing dialog for chats, projects and prompt libraries: who has
 * access, add a person (with a role where the resource has roles, and an
 * optional expiry), revoke, and — for projects and libraries — publish to
 * the whole organization. People come from the tenant directory.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import LocalTime from '@/components/local-time';
import { chatClient } from '@/lib/chat/client';
import type { GrantRole, GrantView, ResourceKind } from '@/lib/chat/access';

interface Person {
  subject: string;
  email: string;
  displayName: string | null;
}

export default function ShareModal({
  tenantId,
  kind,
  resourceId,
  title,
  published,
  onClose,
}: {
  tenantId: string;
  kind: ResourceKind;
  resourceId: string;
  title: string;
  /** Present for kinds that can be published to the org. */
  published?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [grants, setGrants] = useState<GrantView[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Person | null>(null);
  const [role, setRole] = useState<GrantRole>('viewer');
  const [expiresAt, setExpiresAt] = useState('');
  const [publish, setPublish] = useState(published ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await chatClient.grants(tenantId, kind, resourceId);
    if (result.error) setError(result.error);
    else setGrants(result.data?.grants ?? []);
  }, [tenantId, kind, resourceId]);
  useEffect(() => {
    void load();
    void chatClient.people(tenantId).then((result) => {
      if (result.data) setPeople(result.data.people);
    });
  }, [load, tenantId]);

  const suggestions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return people
      .filter(
        (person) =>
          person.email.toLowerCase().includes(needle) ||
          (person.displayName ?? '').toLowerCase().includes(needle)
      )
      .slice(0, 6);
  }, [people, query]);

  const add = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const result = await chatClient.grant(tenantId, kind, resourceId, {
      granteeSubject: chosen.subject,
      role: kind === 'chat' ? 'viewer' : role,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setChosen(null);
    setQuery('');
    setExpiresAt('');
    await load();
    router.refresh();
  };

  const revoke = async (grantId: string) => {
    setBusy(true);
    const result = await chatClient.revoke(tenantId, kind, resourceId, grantId);
    setBusy(false);
    if (result.error) setError(result.error);
    await load();
    router.refresh();
  };

  const togglePublish = async (on: boolean) => {
    if (kind === 'chat') return;
    setPublish(on);
    const result = await chatClient.publish(tenantId, kind, resourceId, on);
    if (result.error) {
      setError(result.error);
      setPublish(!on);
      return;
    }
    router.refresh();
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4 text-sm">
        {kind === 'chat' ? (
          <p className="text-gray-600 dark:text-gray-400">
            People you share with can read this chat and watch it live. Only you can continue it.
          </p>
        ) : (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={publish}
              onChange={(event) => void togglePublish(event.target.checked)}
            />
            <span>Everyone in the organization can view this</span>
          </label>
        )}

        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-500">Add a person</label>
          {chosen ? (
            <div className="flex items-center gap-2 rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700">
              <span className="flex-1 truncate">{chosen.displayName ?? chosen.email}</span>
              <button
                type="button"
                onClick={() => setChosen(null)}
                className="text-xs text-gray-500 hover:underline"
              >
                change
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or email"
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
              />
              {suggestions.length > 0 ? (
                <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
                  {suggestions.map((person) => (
                    <li key={person.subject}>
                      <button
                        type="button"
                        onClick={() => {
                          setChosen(person);
                          setQuery('');
                        }}
                        className="block w-full px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        {person.displayName ?? person.email}
                        {person.displayName ? (
                          <span className="ml-1 text-xs text-gray-500">{person.email}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {kind !== 'chat' ? (
              <select
                value={role}
                onChange={(event) => setRole(event.target.value === 'editor' ? 'editor' : 'viewer')}
                className="rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="viewer">Can view</option>
                <option value="editor">Can edit</option>
              </select>
            ) : null}
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              aria-label="Expires"
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
            />
            <button
              type="button"
              disabled={!chosen || busy}
              onClick={() => void add()}
              className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Share
            </button>
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-gray-500">Who has access</p>
          {grants === null ? (
            <p className="text-gray-500">Loading…</p>
          ) : grants.length === 0 ? (
            <p className="text-gray-500">Nobody yet.</p>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-800">
              {grants.map((grant) => (
                <li key={grant.id} className="flex items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    {grant.granteeName ?? grant.granteeEmail ?? grant.granteeSubject}
                    <span className="ml-1 text-xs text-gray-500">
                      {grant.role === 'editor' ? 'edit' : 'view'}
                      {grant.expiresAt ? (
                        <>
                          {' · '}
                          {grant.expired ? 'expired ' : 'until '}
                          <LocalTime at={grant.expiresAt} format="date" />
                        </>
                      ) : null}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(grant.id)}
                    className="text-xs text-red-600 hover:underline dark:text-red-400"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error ? <p className="text-red-600">{error}</p> : null}
      </div>
    </Modal>
  );
}
