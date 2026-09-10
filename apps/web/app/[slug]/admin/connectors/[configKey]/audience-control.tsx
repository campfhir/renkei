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

import { useState } from 'react';
import ChipListInput, { type ChipOption } from '@/components/chip-list-input';

export default function AudienceControl({
  slug,
  capabilityKey,
  label,
  initialValues,
  groupsClaim,
  observedGroups,
}: {
  slug: string;
  capabilityKey: string;
  label: string;
  initialValues: string[];
  /** The id_token claim the values are read from, for the hint. */
  groupsClaim: string;
  /** How many distinct values sign-ins have recorded so far. */
  observedGroups: number;
}) {
  const [mode, setMode] = useState<'everyone' | 'groups'>(
    initialValues.length > 0 ? 'groups' : 'everyone'
  );
  const [values, setValues] = useState<string[]>(initialValues);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string[]) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch(`/api/admin/${slug}/connector-audience/${capabilityKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimValues: next }),
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
      setNotice(
        next.length === 0
          ? 'Saved. Offered to everyone again.'
          : `Saved. Only people in ${next.length} group${next.length === 1 ? '' : 's'} are offered ${label}; tool lists refresh within a minute.`
      );
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function loadOptions(query: string): Promise<ChipOption[]> {
    const response = await fetch(`/api/admin/${slug}/idp-groups?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('Could not load the groups seen at sign-in.');
    const body: { groups?: ChipOption[] } = await response.json();
    return body.groups ?? [];
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="font-semibold">Who {label} is for</h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Groups come from the <code className="text-xs">{groupsClaim}</code> claim at sign-in;{' '}
        {observedGroups} distinct value{observedGroups === 1 ? '' : 's'} seen so far. Outside the
        audience, the connector is not offered and its tools do not register — for anyone already
        connected too.
      </p>
      <fieldset className="mt-3 space-y-2">
        <legend className="sr-only">Audience</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`audience-${capabilityKey}`}
            checked={mode === 'everyone'}
            disabled={busy}
            onChange={() => {
              setMode('everyone');
              if (values.length > 0) {
                setValues([]);
                void save([]);
              }
            }}
          />
          Everyone in the organization
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`audience-${capabilityKey}`}
            checked={mode === 'groups'}
            disabled={busy}
            onChange={() => setMode('groups')}
          />
          Only people in these IdP groups
        </label>
      </fieldset>
      {mode === 'groups' && (
        <div className="mt-3">
          <ChipListInput
            values={values}
            onChange={(next) => {
              setValues(next);
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
