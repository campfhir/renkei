'use client';

import { useMemo, useReducer } from 'react';
import { sendJsonFull } from '@/lib/fetch-json';
import { formatReset, formatTokens, limitProgress } from '@/lib/token-limits/format';
import {
  WEEKDAYS,
  boostHasEffect,
  boostRequest,
  boostTotal,
  canGrant,
  canSave,
  initTokenLimits,
  isAmount,
  isDirty,
  limitsAnything,
  saveRequest,
  timeZoneOptions,
  tokenLimitsReducer,
  visiblePeople,
  type Person,
  type TokenLimitsView,
} from './token-limits.model';

const inputClass =
  'w-28 rounded-md border bg-white px-2 py-1 text-sm tabular-nums dark:bg-gray-900';
const borderOf = (valid: boolean) =>
  valid ? 'border-gray-300 dark:border-gray-700' : 'border-red-500';
const sectionClass =
  'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950';
const headingClass = 'mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500';

function AmountInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
}) {
  const valid = isAmount(value);
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={!valid}
      placeholder="No limit"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`${inputClass} ${borderOf(valid)}`}
    />
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="min-w-0 max-w-md">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      </div>
      {children}
    </div>
  );
}

/** A thin bar: how much of a limit is used. */
function Bar({ percent, reached, near }: { percent: number; reached: boolean; near: boolean }) {
  const tone = reached ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-blue-600';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function Standing({
  title,
  used,
  limit,
  boost,
}: {
  title: string;
  used: number;
  limit: number;
  boost: number;
}) {
  const progress = limitProgress(used, limit > 0 ? limit : null, boost);
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap justify-between gap-x-2 text-xs text-gray-600 dark:text-gray-400">
        <span>{title}</span>
        <span className="tabular-nums">
          {progress.label}
          {boost > 0 && progress.limit !== null ? ` (+${formatTokens(boost)} boost)` : ''}
        </span>
      </p>
      {progress.limit !== null && (
        <Bar percent={progress.percent} reached={progress.reached} near={progress.near} />
      )}
    </div>
  );
}

/**
 * The Token limits page: the organization's limits under one Save, then
 * everyone with where they stand, each person's exemption and boosts
 * changed on their own row. What the page decides is token-limits.model.ts.
 */
export function TokenLimitsForm({ initial }: { initial: TokenLimitsView }) {
  const [state, dispatch] = useReducer(tokenLimitsReducer, initial, initTokenLimits);
  const { draft, view } = state;
  const people = visiblePeople(state);
  const zone = view.policy.timeZone;
  // The browser's list of zones; the stored one is offered even if it is not on it.
  const zones = useMemo(
    () =>
      timeZoneOptions(
        zone,
        typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
      ),
    [zone]
  );

  async function save() {
    const request = saveRequest(state);
    if (!request) return;
    dispatch({ type: 'saveSent' });
    const result = await sendJsonFull<TokenLimitsView>('/api/admin/token-limits', 'PUT', request);
    if (result.error || !result.data) dispatch({ type: 'saveFailed', error: result.error });
    else dispatch({ type: 'saved', view: result.data });
  }

  async function changePerson(
    key: string,
    url: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body?: unknown
  ) {
    dispatch({ type: 'personSent', key });
    const result = await sendJsonFull<TokenLimitsView>(url, method, body);
    if (result.error || !result.data) dispatch({ type: 'personFailed', error: result.error });
    else dispatch({ type: 'personStored', view: result.data });
  }

  function personRow(person: Person) {
    const open = state.boost?.subject === person.subject;
    const busy = state.busy !== null;
    return (
      <li
        key={person.subject}
        data-person={person.subject}
        className="space-y-2 py-3 first:pt-0 last:pb-0"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {person.name}
              {person.exempt && (
                <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-xs font-normal text-green-800 dark:bg-green-900/40 dark:text-green-300">
                  Unlimited
                </span>
              )}
            </p>
            <p className="truncate text-xs text-gray-500">{person.email}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                changePerson(
                  person.subject,
                  `/api/admin/token-limits/people/${encodeURIComponent(person.subject)}`,
                  'PUT',
                  { exempt: !person.exempt }
                )
              }
              className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              {person.exempt ? 'Apply limits' : 'Make unlimited'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                dispatch(
                  open ? { type: 'boostClosed' } : { type: 'boostOpened', subject: person.subject }
                )
              }
              className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              {open ? 'Cancel' : 'Grant boost'}
            </button>
          </div>
        </div>

        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <Standing
            title="This week"
            used={person.weekUsed}
            limit={person.exempt ? 0 : view.policy.weekly}
            boost={boostTotal(person, 'week')}
          />
          <Standing
            title="This month"
            used={person.monthUsed}
            limit={person.exempt ? 0 : view.policy.monthly}
            boost={boostTotal(person, 'month')}
          />
        </div>

        {person.boosts.length > 0 && (
          <ul className="space-y-1">
            {person.boosts.map((boost) => (
              <li
                key={boost.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1 text-xs dark:bg-gray-900"
              >
                <span>
                  +{formatTokens(boost.tokens)} for the {boost.period}, until{' '}
                  {formatReset(boost.expiresAt, zone)}
                  {boost.note ? ` — ${boost.note}` : ''}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    changePerson(boost.id, `/api/admin/token-limits/boosts/${boost.id}`, 'DELETE')
                  }
                  className="text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                >
                  Take back
                </button>
              </li>
            ))}
          </ul>
        )}

        {open && state.boost && (
          <form
            className="flex flex-wrap items-end gap-2 rounded border border-gray-200 p-2 dark:border-gray-800"
            onSubmit={(event) => {
              event.preventDefault();
              const request = boostRequest(state);
              if (request && canGrant(state)) {
                void changePerson(
                  person.subject,
                  '/api/admin/token-limits/boosts',
                  'POST',
                  request
                );
              }
            }}
          >
            <label className="text-xs">
              <span className="mb-1 block text-gray-500">For</span>
              <select
                aria-label="Boost period"
                value={state.boost.period}
                onChange={(event) =>
                  dispatch({
                    type: 'boostChanged',
                    patch: { period: event.target.value === 'month' ? 'month' : 'week' },
                  })
                }
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="week">This week</option>
                <option value="month">This month</option>
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-gray-500">Extra tokens</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label="Boost tokens"
                placeholder="500K"
                value={state.boost.tokens}
                onChange={(event) =>
                  dispatch({ type: 'boostChanged', patch: { tokens: event.target.value } })
                }
                className={`${inputClass} ${borderOf(isAmount(state.boost.tokens))}`}
              />
            </label>
            <label className="min-w-40 flex-1 text-xs">
              <span className="mb-1 block text-gray-500">Note (optional)</span>
              <input
                type="text"
                aria-label="Boost note"
                maxLength={500}
                value={state.boost.note}
                onChange={(event) =>
                  dispatch({ type: 'boostChanged', patch: { note: event.target.value } })
                }
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            </label>
            <button
              type="submit"
              disabled={!canGrant(state)}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Grant
            </button>
            {!boostHasEffect(view.policy, state.boost.period) && (
              <p className="w-full text-xs text-amber-700 dark:text-amber-400">
                There is no {state.boost.period === 'week' ? 'weekly' : 'monthly'} limit to add to,
                so this boost would change nothing.
              </p>
            )}
            {state.personError && (
              <p role="alert" className="w-full text-xs text-red-600">
                {state.personError}
              </p>
            )}
          </form>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-4">
      <section className={sectionClass}>
        <h2 className={headingClass}>Per person</h2>
        <div className="space-y-4">
          <Row
            label="Weekly limit"
            hint="Tokens one person may spend in a week, input and output together. Type an amount like 2M or 500K; leave empty for no weekly limit."
          >
            <AmountInput
              label="Weekly limit"
              value={draft.weekly}
              onChange={(weekly) => dispatch({ type: 'limitsChanged', patch: { weekly } })}
            />
          </Row>
          <Row
            label="Monthly limit"
            hint="The same per calendar month, which resets on the 1st at 00:00 in the time zone below. Leave empty for no monthly limit."
          >
            <AmountInput
              label="Monthly limit"
              value={draft.monthly}
              onChange={(monthly) => dispatch({ type: 'limitsChanged', patch: { monthly } })}
            />
          </Row>
          <Row
            label="The week resets on"
            hint={`The day and time of day the weekly count starts over, on a clock in the time zone below. This week resets ${formatReset(view.weekResetsAt, zone)}.`}
          >
            <span className="flex items-center gap-2">
              <select
                aria-label="Weekly reset day"
                value={draft.weekResetDay}
                onChange={(event) =>
                  dispatch({
                    type: 'limitsChanged',
                    patch: { weekResetDay: Number(event.target.value) },
                  })
                }
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
              <input
                type="time"
                aria-label="Weekly reset time"
                value={draft.weekResetTime}
                onChange={(event) =>
                  dispatch({ type: 'limitsChanged', patch: { weekResetTime: event.target.value } })
                }
                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            </span>
          </Row>
          <Row
            label="Time zone"
            hint={`The zone the resets are told in: the week's day and time, and the month's 1st at midnight. Where clocks change for daylight saving, the reset keeps its time of day. This month resets ${formatReset(view.monthResetsAt, zone)}.`}
          >
            <select
              aria-label="Reset time zone"
              value={draft.timeZone}
              onChange={(event) =>
                dispatch({ type: 'limitsChanged', patch: { timeZone: event.target.value } })
              }
              className="max-w-[16rem] rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              {zones.map((name) => (
                <option key={name} value={name}>
                  {name.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Row>
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className={headingClass}>Per model</h2>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          A limit of its own for a model that costs more: the most one person may spend on it in a
          week or a month. It applies on top of the limits above, and a boost does not raise it. At
          a model’s limit the person can still use the other models.
        </p>
        {view.models.length === 0 ? (
          <p className="text-sm text-gray-500">No models are configured yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-900">
            {view.models.map((model) => (
              <li
                key={model.id}
                data-model={model.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="min-w-0 truncate text-sm">
                  {model.label}
                  {!model.enabled && <span className="ml-2 text-xs text-gray-500">(off)</span>}
                </span>
                <span className="flex items-center gap-2 text-xs text-gray-500">
                  Weekly
                  <AmountInput
                    label={`Weekly limit for ${model.label}`}
                    value={draft.models[model.id]?.weekly ?? ''}
                    onChange={(weekly) =>
                      dispatch({ type: 'modelChanged', modelId: model.id, patch: { weekly } })
                    }
                  />
                  Monthly
                  <AmountInput
                    label={`Monthly limit for ${model.label}`}
                    value={draft.models[model.id]?.monthly ?? ''}
                    onChange={(monthly) =>
                      dispatch({ type: 'modelChanged', modelId: model.id, patch: { monthly } })
                    }
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!canSave(state)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {state.phase === 'saving' ? 'Saving…' : 'Save limits'}
        </button>
        {state.phase === 'saved' && <span className="text-xs text-green-600">Saved.</span>}
        {state.error && (
          <span role="alert" className="text-xs text-red-600">
            {state.error}
          </span>
        )}
        {isDirty(state) && state.phase !== 'saving' && (
          <span className="text-xs text-gray-500">Unsaved changes</span>
        )}
      </div>

      <section className={sectionClass}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">People</h2>
          <input
            type="search"
            aria-label="Find a person"
            placeholder="Find a person"
            value={state.filter}
            onChange={(event) => dispatch({ type: 'filterChanged', filter: event.target.value })}
            className="w-56 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          {limitsAnything(view.policy)
            ? 'What each person has used since the week and the month began, their agents included. An unlimited person is counted but never stopped; a boost adds to their limit until the period it was granted in resets.'
            : 'No limits are set, so nobody is stopped. This is what each person has used since the week and the month began.'}
        </p>
        {state.personError && !state.boost && (
          <p role="alert" className="mb-2 text-xs text-red-600">
            {state.personError}
          </p>
        )}
        {people.length === 0 ? (
          <p className="text-sm text-gray-500">Nobody matches.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-900">{people.map(personRow)}</ul>
        )}
      </section>
    </div>
  );
}
