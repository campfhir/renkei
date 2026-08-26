'use client';

/**
 * The editor-panel body for triggers. Two modes:
 *  - chooser (a NEW trigger): the event catalog plus the other kinds —
 *    choosing one attaches it and the panel switches to editing it;
 *  - detail (an existing trigger): the kind's own controls. Schedules mount
 *    the full ScheduleEditor — the reason the panel supports 'wide'.
 *
 * API triggers show only a key HINT after creation; the key itself appears
 * once, in the save response, and never again.
 */

import {
  TRIGGER_EVENT_CATALOG,
  VARIABLE_NAME_PATTERN,
  triggerEventById,
  type TriggerDraft,
} from '@renkei/agents';
import ChipListInput from '@/components/chip-list-input';
import { ScheduleEditor, type CalendarOption } from './schedule-picker';
import { providesOf, type AgentChoice, type BuilderTrigger } from './trigger-node';
import TriggerFilterPanel from './trigger-filter-panel';

const inputClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** Chooser mode — pick what kind of trigger to attach. */
export function TriggerChooser({
  otherAgents,
  onChoose,
}: {
  otherAgents: AgentChoice[];
  onChoose: (draft: TriggerDraft) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        When something happens
      </p>
      <div className="flex flex-wrap gap-2">
        {TRIGGER_EVENT_CATALOG.map((event) => (
          <button
            key={event.id}
            type="button"
            onClick={() => onChoose({ kind: 'event', eventId: event.id })}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-left text-sm hover:border-blue-500 dark:border-gray-700"
            title={event.description}
          >
            {event.label}
          </button>
        ))}
      </div>
      <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Other ways
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            onChoose({
              kind: 'schedule',
              recurrences: [{ every: 'day', at: '09:00' }],
              timezone: defaultTimezone(),
            })
          }
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:border-blue-500 dark:border-gray-700"
        >
          On a schedule
        </button>
        {otherAgents.length > 0 ? (
          <select
            aria-label="After another agent"
            className={inputClass}
            value=""
            onChange={(event) => {
              if (event.target.value) {
                onChoose({ kind: 'agent', callerAgentId: event.target.value });
              }
            }}
          >
            <option value="">After another agent…</option>
            {otherAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={() => onChoose({ kind: 'api', inputs: [] })}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:border-blue-500 dark:border-gray-700"
        >
          From an API call
        </button>
      </div>
    </div>
  );
}

/** Detail mode — edit one attached trigger. */
export function TriggerEditor({
  tenantId,
  trigger,
  otherAgents,
  calendars,
  onChange,
}: {
  /** For the filter pickers, which list the caller's own spaces and people. */
  tenantId: string;
  trigger: BuilderTrigger;
  otherAgents: AgentChoice[];
  calendars: CalendarOption[];
  onChange: (draft: TriggerDraft) => void;
}) {
  const draft = trigger.draft;

  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        <span>This trigger gives your steps:</span>
        {providesOf(draft).map((label) => (
          <span
            key={label}
            className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300"
          >
            {label}
          </span>
        ))}
      </p>

      {trigger.lastError ? (
        <p className="text-xs text-red-600 dark:text-red-400">Last problem: {trigger.lastError}</p>
      ) : null}

      {draft.kind === 'event' ? (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {triggerEventById(draft.eventId)?.description ?? 'Runs when this event happens.'}
          </p>
          <TriggerFilterPanel
            tenantId={tenantId}
            eventId={draft.eventId}
            match={draft.match ?? {}}
            onChange={(match) => onChange({ kind: 'event', eventId: draft.eventId, match })}
          />
        </>
      ) : null}

      {draft.kind === 'agent' ? (
        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="trigger-agent">
            Runs after which agent?
          </label>
          <select
            id="trigger-agent"
            className={inputClass}
            value={draft.callerAgentId}
            onChange={(event) => onChange({ kind: 'agent', callerAgentId: event.target.value })}
          >
            {otherAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {draft.kind === 'schedule' ? (
        <ScheduleEditor
          value={draft}
          onChange={(config) => onChange({ kind: 'schedule', ...config })}
          calendars={calendars}
        />
      ) : null}

      {draft.kind === 'api' ? (
        <>
          {trigger.keyHint ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Key ends in …{trigger.keyHint} (shown once when created)
            </p>
          ) : null}
          <ApiInputsEditor
            inputs={draft.inputs}
            onChange={(inputs) => onChange({ kind: 'api', inputs })}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * On ChipListInput rather than its own chip row: this had the only bare `×`
 * left in the builder, which said "remove" to a sighted reader and nothing
 * at all to anyone else. An input's `label` tracks its `name` because
 * nothing here lets the two be edited apart.
 */
function ApiInputsEditor({
  inputs,
  onChange,
}: {
  inputs: { name: string; label: string }[];
  onChange: (inputs: { name: string; label: string }[]) => void;
}) {
  return (
    <ChipListInput
      label="Inputs the caller sends"
      hint="Name the pieces of information a caller will send; your steps can then use them."
      placeholder="e.g. workItem"
      values={inputs.map((input) => input.name)}
      onChange={(names) =>
        onChange(
          names.map((name) => inputs.find((entry) => entry.name === name) ?? { name, label: name })
        )
      }
      validate={(value) =>
        VARIABLE_NAME_PATTERN.test(value)
          ? null
          : 'Start with a letter, then letters, numbers, spaces, ".", "-" or "_".'
      }
      emptyMeans="No inputs — the caller sends nothing but the request itself."
    />
  );
}
