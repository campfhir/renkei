'use client';

/**
 * One sharing dialog for chats, projects and prompt libraries: who has
 * access, add a person (with a role where the resource has roles, and an
 * optional expiry), revoke. People come from the tenant directory. There
 * is no "publish to the organization": a project's content is under a key
 * wrapped to the people invited (docs/delegate-key-design.md, decision 1),
 * and no tenant-wide key exists to publish under.
 */

import { useCallback, useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import Modal from '@/components/modal';
import LocalTime from '@/components/local-time';
import { chatClient } from '@/lib/chat/client';
import type { ResourceKind } from '@/lib/chat/access';
import { LoadingRegion, SkeletonList } from '@/components/skeleton';
import {
  canShare,
  grantAbility,
  granteeName,
  grantRequest,
  hasRoles,
  initialShare,
  personName,
  personSuggestions,
  shareIntro,
  shareReducer,
} from './share-modal.model';

export default function ShareModal({
  kind,
  resourceId,
  title,
  onClose,
}: {
  kind: ResourceKind;
  resourceId: string;
  title: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(shareReducer, initialShare);
  const { grants, chosen, busy, error } = state;

  const load = useCallback(async () => {
    const result = await chatClient.grants(kind, resourceId);
    if (result.error) dispatch({ type: 'loadFailed', error: result.error });
    else dispatch({ type: 'grantsLoaded', grants: result.data?.grants ?? [] });
  }, [kind, resourceId]);
  useEffect(() => {
    void load();
    void chatClient.people().then((result) => {
      if (result.data) dispatch({ type: 'peopleLoaded', people: result.data.people });
    });
  }, [load]);

  const suggestions = personSuggestions(state.people, state.query);

  const add = async () => {
    const body = grantRequest(kind, state);
    if (!body) return;
    dispatch({ type: 'sent', clearsError: true });
    const result = await chatClient.grant(kind, resourceId, body);
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'shared' });
    await load();
    router.refresh();
  };

  const revoke = async (grantId: string) => {
    dispatch({ type: 'sent', clearsError: false });
    const result = await chatClient.revoke(kind, resourceId, grantId);
    dispatch({ type: 'revoked', error: result.error });
    await load();
    router.refresh();
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-gray-600 dark:text-gray-400">{shareIntro(kind)}</p>

        <div className="space-y-2">
          <label className="block text-xs font-medium text-gray-500">Add a person</label>
          {chosen ? (
            <div className="flex items-center gap-2 rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700">
              <span className="flex-1 truncate">{personName(chosen)}</span>
              <button
                type="button"
                onClick={() => dispatch({ type: 'unchosen' })}
                className="text-xs text-gray-500 hover:underline"
              >
                change
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                value={state.query}
                onChange={(event) => dispatch({ type: 'typed', query: event.target.value })}
                placeholder="Name or email"
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
              />
              {suggestions.length > 0 ? (
                <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
                  {suggestions.map((person) => (
                    <li key={person.subject}>
                      <button
                        type="button"
                        onClick={() => dispatch({ type: 'chosen', person })}
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
            {hasRoles(kind) ? (
              <select
                value={state.role}
                onChange={(event) =>
                  dispatch({
                    type: 'roleChanged',
                    role: event.target.value === 'editor' ? 'editor' : 'viewer',
                  })
                }
                className="rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="viewer">Can view</option>
                <option value="editor">Can edit</option>
              </select>
            ) : null}
            <input
              type="datetime-local"
              value={state.expiresAt}
              onChange={(event) =>
                dispatch({ type: 'expiryChanged', expiresAt: event.target.value })
              }
              aria-label="Expires"
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
            />
            <button
              type="button"
              disabled={!canShare(state)}
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
            <LoadingRegion label="Loading who has access…">
              <SkeletonList rows={2} />
            </LoadingRegion>
          ) : grants.length === 0 ? (
            <p className="text-gray-500">Nobody yet.</p>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-800">
              {grants.map((grant) => (
                <li key={grant.id} className="flex items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate">
                    {granteeName(grant)}
                    <span className="ml-1 text-xs text-gray-500">
                      {grantAbility(kind, grant)}
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
