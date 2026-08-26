'use client';

import {
  describeTriggerMatch,
  triggerFilterFields,
  type FilterOptionSource,
  type TriggerFilterField,
  type TriggerMatch,
} from '@renkei/agents';
import ChipListInput, { type ChipOption } from '@/components/chip-list-input';

/**
 * "Only run when…" — the deterministic layer, given a surface of its own.
 *
 * This is the cheapest thing in the product: a filter is checked before a
 * run row exists, so an event it rejects costs one string comparison
 * instead of a run, a model call and everything the model then decides to
 * do. The panel is worth the room it takes because that saving is
 * invisible otherwise, and because a person needs to be able to tell at a
 * glance that nothing here is a model's judgement.
 *
 * The container is deliberately NOT one of the node colours — dashed and
 * neutral, so it reads as machinery bolted to the trigger rather than as
 * another step in the flow. The fields themselves are catalog data
 * (`trigger-catalog.ts`), so a connector gains filters without this file
 * changing.
 */

/** Where a picker's options come from. Mirrors FilterOptionSource. */
const OPTION_ROUTES: Record<FilterOptionSource, (tenantId: string) => string> = {
  'webex-rooms': (tenantId) => `/api/tenant/${tenantId}/webex/rooms`,
  'microsoft-people': (tenantId) => `/api/tenant/${tenantId}/directory/people`,
};

const BROWSE_LABELS: Record<FilterOptionSource, { browse: string; search: string }> = {
  'webex-rooms': { browse: 'Choose spaces', search: 'Filter your spaces…' },
  'microsoft-people': { browse: 'Find people', search: 'Search the directory…' },
};

async function loadOptions(
  tenantId: string,
  source: FilterOptionSource,
  query: string
): Promise<ChipOption[]> {
  const url = new URL(OPTION_ROUTES[source](tenantId), window.location.origin);
  if (query) url.searchParams.set('q', query);
  const response = await fetch(url.toString());
  const parsed: unknown = await response.json().catch(() => null);
  const body: { options?: ChipOption[]; error?: string } =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  if (!response.ok) throw new Error(body.error ?? 'Could not load the list.');
  return body.options ?? [];
}

function valuesOf(match: TriggerMatch, field: TriggerFilterField): string[] {
  const value = match[field.id];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalarOf(match: TriggerMatch, field: TriggerFilterField): string {
  const value = match[field.id];
  if (value === undefined) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

export default function TriggerFilterPanel({
  tenantId,
  eventId,
  match,
  onChange,
}: {
  tenantId: string;
  eventId: string;
  match: TriggerMatch;
  onChange: (next: TriggerMatch) => void;
}) {
  const fields = triggerFilterFields(eventId);
  if (fields.length === 0) return null;

  // An empty value is REMOVED rather than stored as ''. An empty string
  // means "no constraint" to the matcher either way, but keeping it would
  // leave the stored filter looking set when it is not.
  function set(field: TriggerFilterField, value: string | string[]) {
    const next: TriggerMatch = { ...match };
    const empty = Array.isArray(value) ? value.length === 0 : value.trim() === '';
    if (empty) delete next[field.id];
    else next[field.id] = value;
    onChange(next);
  }

  const summary = describeTriggerMatch(eventId, match);

  return (
    <section className="rounded-lg border border-dashed border-gray-300 bg-gray-50/60 p-3 dark:border-gray-700 dark:bg-gray-900/40">
      <h4 className="text-sm font-semibold">Only run when…</h4>
      <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
        Checked before the agent starts — no model is involved, and an event these rules turn away
        costs nothing at all.
      </p>

      <div className="mt-3 space-y-3">
        {fields.map((field) => {
          const source = field.picker ?? field.suggest;
          const wording = source ? BROWSE_LABELS[source] : null;

          if (field.input === 'text') {
            return (
              <div key={field.id}>
                <label className="text-sm font-medium" htmlFor={`filter-${field.id}`}>
                  {field.label}
                </label>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{field.hint}</p>
                <input
                  id={`filter-${field.id}`}
                  value={scalarOf(match, field)}
                  placeholder={field.placeholder}
                  maxLength={field.maxLength}
                  onChange={(event) => set(field, event.target.value)}
                  className="mt-1.5 w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
                />
              </div>
            );
          }

          return (
            <ChipListInput
              key={field.id}
              label={field.label}
              hint={field.hint}
              placeholder={field.placeholder}
              max={field.maxEntries}
              values={valuesOf(match, field)}
              onChange={(next) => set(field, next)}
              // Always true, picker or not: a picker that cannot list
              // something must never make it unreachable.
              allowFreeText
              normalize={(raw) =>
                field.match === 'id-equals-any' ? raw.trim() : raw.trim().toLowerCase()
              }
              validate={(value) =>
                field.pattern && !field.pattern.test(value) ? field.invalidMessage : null
              }
              loadOptions={source ? (query) => loadOptions(tenantId, source, query) : undefined}
              browseLabel={wording?.browse}
              searchPlaceholder={wording?.search}
              emptyMeans="Empty means no limit here — every one of these events gets through."
            />
          );
        })}
      </div>

      <p className="mt-3 border-t border-gray-200 pt-2 text-xs text-gray-600 dark:border-gray-800 dark:text-gray-400">
        {summary ? (
          <>
            Runs only <strong>{summary}</strong>.
          </>
        ) : (
          'No filters — this runs on every one of these events.'
        )}
      </p>
    </section>
  );
}
