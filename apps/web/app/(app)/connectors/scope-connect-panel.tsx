'use client';

/**
 * The scope-narrowing + connect (or reconnect) control shared by every
 * single-catalog OAuth card (Jira, JSM, Confluence, Bitbucket, Zoom,
 * GitHub, WebEx). Six of these were near-identical copies before this file
 * existed — same ceiling/pickable filtering, same seed-from-prior-grant
 * logic, same "what Renkei may do (N of M)" summary, same authorize link.
 *
 * `ConnectScopePanel` renders the whole not-yet-connected block: the
 * `<details>` picker plus the primary "Connect X" button, each carrying its
 * own coach-mark anchor. `ReconnectScopePanel` renders just the picker plus
 * an "Approve updated permissions" link, meant to sit inside the
 * server-rendered `<AuthorizedPermissions>` as its `children` — that
 * component supplies the surrounding disclosure and "connected already"
 * framing; the coach anchor that used to wrap it goes on a server-rendered
 * `<CoachTarget>` around the whole block instead (see connector-shell.tsx's
 * doc comment on `useCoachAnchor` vs `CoachTarget`).
 *
 * What the selection decides (what is offered and ticked, the summary, the
 * authorize URL) is scope-connect-panel.model.ts's.
 *
 * Microsoft's card does NOT use this: its selection is a single union across
 * several product panels feeding one link, not one catalog per card.
 */

import { useReducer } from 'react';
import ScopePicker from '@/components/scope-picker';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import type { CoachAnchor } from '@/lib/coach-marks/anchors';
import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import {
  authorizeHref,
  connectBlockedReason,
  initScopeSelection,
  overUrlBudget,
  scopeSelectionReducer,
  selectionSummary,
  type ScopeSelectionContext,
} from './scope-connect-panel.model';

/** The selection both panels hold (scope-connect-panel.model.ts decides it). */
function useScopeSelection(context: ScopeSelectionContext) {
  const [state, dispatch] = useReducer(scopeSelectionReducer, context, initScopeSelection);
  return {
    state,
    toggleOption: (optionId: string, on: boolean) => dispatch({ type: 'toggled', optionId, on }),
  };
}

interface CatalogProps {
  groups: ScopeGroup[];
  options: ScopeOption[];
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
  /** Authorize route, WITHOUT the `?scopes=` query string. */
  authorizePath: string;
}

export function ConnectScopePanel({
  groups,
  options,
  ceiling,
  priorScopes,
  authorizePath,
  connectLabel,
  scopesAnchor,
  connectAnchor,
  extraPickerNote,
  pickerNote,
  urlBudget,
}: CatalogProps & {
  /** Label on the primary connect button, e.g. "Connect Zoom". */
  connectLabel: string;
  scopesAnchor: CoachAnchor;
  connectAnchor: CoachAnchor;
  /** Extra sentence appended after the standard "org allows at most" note. */
  extraPickerNote?: React.ReactNode;
  /** Replaces the standard note outright, for connectors where "have" isn't the right verb (Bitbucket/GitHub fix scopes on the app; unchecking only narrows what Renkei USES). */
  pickerNote?: React.ReactNode;
  /** Atlassian's consent-URL length warning; omit for connectors that don't hit it. */
  urlBudget?: { baseChars: number; limit: number; message: React.ReactNode };
}) {
  const context = { options, ceiling, priorScopes };
  const { state, toggleOption } = useScopeSelection(context);
  const authorizeUrl = authorizeHref(authorizePath, state, context);
  const overBudget = overUrlBudget(urlBudget, state, context);
  const blocked = connectBlockedReason(state);

  const detailsAnchor = useCoachAnchor(scopesAnchor);
  const linkAnchor = useCoachAnchor(connectAnchor);

  return (
    <div className="mt-3">
      <details
        {...detailsAnchor}
        className="mb-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
      >
        <summary className="cursor-pointer text-sm font-medium">
          {selectionSummary(state, context)}
        </summary>
        <div className="mt-3">
          <ScopePicker
            groups={groups}
            options={options}
            checked={state.selected}
            onToggle={toggleOption}
            available={ceiling}
            audience="user"
          />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {pickerNote ?? (
              <>
                Your organization allows at most these. Uncheck anything you don&apos;t want Renkei
                to have — you can reconnect later to change it.
                {extraPickerNote}
              </>
            )}
          </p>
          {urlBudget && overBudget && (
            <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              {urlBudget.message}
            </p>
          )}
        </div>
      </details>
      {blocked ? (
        <>
          <button
            {...linkAnchor}
            type="button"
            disabled
            className="inline-block cursor-not-allowed rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white opacity-50"
          >
            {connectLabel}
          </button>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{blocked}</p>
        </>
      ) : (
        <a
          {...linkAnchor}
          href={authorizeUrl}
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {connectLabel}
        </a>
      )}
    </div>
  );
}

export function ReconnectScopePanel({
  groups,
  options,
  ceiling,
  priorScopes,
  authorizePath,
  approveLabel = 'Approve updated permissions',
}: CatalogProps & { approveLabel?: string }) {
  const context = { options, ceiling, priorScopes };
  const { state, toggleOption } = useScopeSelection(context);
  const authorizeUrl = authorizeHref(authorizePath, state, context);
  const blocked = connectBlockedReason(state);

  return (
    <>
      <ScopePicker
        groups={groups}
        options={options}
        checked={state.selected}
        onToggle={toggleOption}
        available={ceiling}
        audience="user"
      />
      {blocked ? (
        <>
          <button
            type="button"
            disabled
            className="mt-3 inline-block cursor-not-allowed rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium opacity-50 dark:border-gray-700"
          >
            {approveLabel}
          </button>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{blocked}</p>
        </>
      ) : (
        <a
          href={authorizeUrl}
          className="mt-3 inline-block rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {approveLabel}
        </a>
      )}
    </>
  );
}
