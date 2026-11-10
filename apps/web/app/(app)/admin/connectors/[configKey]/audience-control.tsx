'use client';

/**
 * Who a connector is for. Everyone, or only people whose sign-in carried
 * one of the named IdP group values.
 *
 * The values are free text with suggestions from what sign-ins have
 * recorded — a picker that could only offer groups already seen would make
 * a rule untypeable until one member signed in, which is backwards for an
 * admin setting things up ahead of a rollout.
 *
 * Restricting is enforced in the capability projection, not on this page:
 * a person outside the audience loses the connector's tools on their next
 * request, connected or not, and the card leaves their connectors page.
 * The control says so, because "restrict" here means restrict.
 */

import { useReducer } from 'react';
import ChipListInput, { type ChipOption } from '@/components/chip-list-input';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  audienceReducer,
  claimHint,
  failedSave,
  initialAudience,
  savedNotice,
  savesOnChoose,
  type AudienceMode,
} from './audience-control.model';

export default function AudienceControl({
  capabilityKey,
  label,
  initialValues,
  groupsClaim,
  observedGroups,
}: {
  capabilityKey: string;
  label: string;
  initialValues: string[];
  /** The id_token claim the values are read from; null when none is configured. */
  groupsClaim: string | null;
  /** How many distinct values sign-ins have recorded so far. */
  observedGroups: number;
}) {
  const [state, dispatch] = useReducer(audienceReducer, initialValues, initialAudience);
  const { mode, values, busy, notice, error } = state;
  const hint = claimHint(groupsClaim, observedGroups);

  async function save(next: string[]) {
    dispatch({ type: 'saving' });
    try {
      const response = await fetch(`/api/admin/connector-audience/${capabilityKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimValues: next }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = failedSave(body);
        reportFetchFailure(
          'PUT',
          `/api/admin/connector-audience/${capabilityKey}`,
          response.status,
          message
        );
        dispatch({ type: 'save-failed', error: message });
        return;
      }
      dispatch({ type: 'saved', notice: savedNotice(next, label) });
    } catch (error) {
      reportFetchFailure(
        'PUT',
        `/api/admin/connector-audience/${capabilityKey}`,
        0,
        'Could not reach the server',
        error
      );
      dispatch({ type: 'save-failed', error: 'Could not reach the server.' });
    }
  }

  function choose(next: AudienceMode) {
    const saves = savesOnChoose(state, next);
    dispatch({ type: 'choose', mode: next });
    if (saves) void save(saves);
  }

  async function loadOptions(query: string): Promise<ChipOption[]> {
    const response = await fetch(`/api/admin/idp-groups?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('Could not load the groups seen at sign-in.');
    const body: { groups?: ChipOption[] } = await response.json();
    return body.groups ?? [];
  }

  const audienceAnchor = useCoachAnchor('admin-connector-audience');

  return (
    <section
      {...audienceAnchor}
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h2 className="font-semibold">Who {label} is for</h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {hint.kind === 'no-claim' ? (
          <>
            No groups claim is configured (Settings → Identity), so nobody is in any group: a
            restricted audience closes the connector to everyone until one is named.{' '}
          </>
        ) : (
          <>
            Groups come from the <code className="text-xs">{hint.claim}</code> claim at sign-in;{' '}
            {hint.seen}{' '}
          </>
        )}
        Outside the audience, the connector is not offered and its tools do not register — for
        anyone already connected too. Nobody is in a group by default: a person is in the audience
        only while their own sign-in carries one of its values.
      </p>
      <fieldset className="mt-3 space-y-2">
        <legend className="sr-only">Audience</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`audience-${capabilityKey}`}
            checked={mode === 'everyone'}
            disabled={busy}
            onChange={() => choose('everyone')}
          />
          Everyone in the organization
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`audience-${capabilityKey}`}
            checked={mode === 'groups'}
            disabled={busy}
            onChange={() => choose('groups')}
          />
          Only people in these IdP groups
        </label>
      </fieldset>
      {mode === 'groups' && (
        <div className="mt-3">
          <ChipListInput
            values={values}
            onChange={(next) => {
              dispatch({ type: 'values', values: next });
              void save(next);
            }}
            label="Groups"
            placeholder="Type a group value and press Enter"
            max={50}
            allowFreeText
            loadOptions={loadOptions}
            browseLabel="Choose from groups seen at sign-in"
            searchPlaceholder="Search groups"
            disabled={busy}
            emptyMeans="Empty means everyone — add a group to restrict."
          />
        </div>
      )}
      {notice && <p className="mt-3 text-sm text-green-700 dark:text-green-400">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </section>
  );
}
