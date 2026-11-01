'use client';

import { useEffect, useReducer } from 'react';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  CATEGORIES,
  initialOutlookPrefs,
  isChecked,
  outlookPrefsReducer,
  prefsOf,
  refusalNotice,
  toggleEnabled,
  toggleRequest,
  type PrefKey,
} from './outlook-indexing-prefs.model';

/**
 * The per-user opt-ins for what Renkei does with Outlook in the background.
 * Everything defaults OFF: granting a scope powers the interactive tools,
 * and anything beyond that is a separate decision made here. Each toggle
 * saves immediately and takes effect within moments (the save triggers the
 * same bootstrap a fresh connect runs).
 *
 * Nothing in Outlook is indexed — it is all personal. The Mail toggle only
 * lets new mail wake the person's agents through the "An email arrives"
 * trigger; agents then read the message live, as this person. Calendar and
 * To Do have no toggle: they are neither indexed nor watched. What the
 * section decides is outlook-indexing-prefs.model.ts.
 */

export default function OutlookIndexingPrefs() {
  const [state, dispatch] = useReducer(outlookPrefsReducer, initialOutlookPrefs);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/microsoft/indexing`);
        if (!response.ok) {
          reportFetchFailure(
            'GET',
            '/api/microsoft/indexing',
            response.status,
            `Request failed (${response.status})`
          );
          return;
        }
        const prefs = prefsOf(await response.json().catch(() => null));
        if (!cancelled && prefs) dispatch({ type: 'loaded', prefs });
      } catch (error) {
        reportFetchFailure(
          'GET',
          '/api/microsoft/indexing',
          0,
          'Could not reach the server',
          error
        );
        // The section renders disabled until the next visit.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(key: PrefKey, on: boolean) {
    const previous = state.prefs;
    if (!previous) return;
    dispatch({ type: 'toggled', key, on });
    try {
      const response = await fetch(`/api/microsoft/indexing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toggleRequest(previous, key, on)),
      });
      if (!response.ok) {
        const notice = refusalNotice(await response.json().catch(() => null));
        reportFetchFailure('PUT', '/api/microsoft/indexing', response.status, notice);
        dispatch({ type: 'failed', previous, notice });
        return;
      }
      dispatch({ type: 'saved', on });
    } catch (error) {
      reportFetchFailure('PUT', '/api/microsoft/indexing', 0, 'Could not reach the server', error);
      dispatch({ type: 'failed', previous, notice: 'Could not reach the server.' });
    }
  }

  const indexingAnchor = useCoachAnchor('outlook-indexing');

  return (
    <div {...indexingAnchor} className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
        What runs in the background
        <span className="ml-1 font-normal">
          — off by default; your scopes only power the tools until you opt in here
        </span>
      </p>
      <div className="mt-2 space-y-1.5">
        {CATEGORIES.map((category) => (
          <label key={category.key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={isChecked(state, category.key)}
              disabled={!toggleEnabled(state)}
              onChange={(event) => void toggle(category.key, event.target.checked)}
              className="mt-0.5"
            />
            <span>
              {category.label}
              <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                — {category.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
      {state.notice && (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{state.notice}</p>
      )}
    </div>
  );
}
