'use client';

/**
 * "When should it run?" — the agent's triggers, several allowed.
 *
 * Each attached trigger renders as a summary row with a teaching strip of
 * the trigger.* chips it gives the steps — the vocabulary lesson happens
 * here, before the user ever types `/` in an instruction. API triggers
 * show only a key HINT after creation; the key itself appears once, in the
 * save response, and never again.
 */

import { useState } from 'react';
import {
  TRIGGER_EVENT_CATALOG,
  triggerEventById,
  type Recurrence,
  type TriggerDraft,
} from '@renkei/agents';
import type { TriggerPayload } from '@/lib/agents/store';
import { SchedulePicker } from './schedule-picker';

const inputClass =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

export interface AgentChoice {
  id: string;
  name: string;
}

/** The payload shape plus the read-only decorations a stored row carries. */
export type BuilderTrigger = TriggerPayload & {
  keyHint?: string | null;
  lastError?: string | null;
};

export interface TriggerPanelProps {
  triggers: BuilderTrigger[];
  onChange: (triggers: BuilderTrigger[]) => void;
  /** The caller's other agents, for "after another agent". */
  otherAgents: AgentChoice[];
  issues: string[];
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

function providesOf(draft: TriggerDraft): string[] {
  switch (draft.kind) {
    case 'event':
      return (triggerEventById(draft.eventId)?.provides ?? []).map((entry) => entry.label);
    case 'api':
      return draft.inputs.map((input) => input.label || input.name);
    case 'agent':
      return ['What the other agent produced'];
    case 'schedule':
      return ['The scheduled time'];
  }
}

function summaryOf(draft: TriggerDraft, otherAgents: AgentChoice[]): string {
  switch (draft.kind) {
    case 'event':
      return triggerEventById(draft.eventId)?.label ?? draft.eventId;
    case 'schedule': {
      const rec: Recurrence = draft.recurrence;
      if (rec.every === 'hour') return 'Every hour';
      if (rec.every === 'day') return `Every day at ${rec.at}`;
      if (rec.every === 'week') {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return `Every ${days[rec.weekday]} at ${rec.at}`;
      }
      return `Monthly on day ${rec.day} at ${rec.at}`;
    }
    case 'agent': {
      const name = otherAgents.find((agent) => agent.id === draft.callerAgentId)?.name;
      return `After “${name ?? 'another agent'}” finishes successfully`;
    }
    case 'api':
      return 'From an API call';
  }
}

export function TriggerPanel({ triggers, onChange, otherAgents, issues }: TriggerPanelProps) {
  const [choosing, setChoosing] = useState(false);

  const add = (draft: TriggerDraft) => {
    onChange([...triggers, { draft, enabled: true }]);
    setChoosing(false);
  };

  const update = (index: number, draft: TriggerDraft) => {
    onChange(triggers.map((entry, at) => (at === index ? { ...entry, draft } : entry)));
  };

  const remove = (index: number) => {
    onChange(triggers.filter((_, at) => at !== index));
  };

  return (
    <div className="space-y-3">
      {triggers.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Nothing starts this agent yet. Add a trigger — you can have several.
        </p>
      ) : (
        <ul className="space-y-2">
          {triggers.map((trigger, index) => (
            <li
              key={trigger.id ?? `new-${index}`}
              className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{summaryOf(trigger.draft, otherAgents)}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    <span>This trigger gives your steps:</span>
                    {providesOf(trigger.draft).map((label) => (
                      <span
                        key={label}
                        className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300"
                      >
                        {label}
                      </span>
                    ))}
                  </p>
                  {trigger.draft.kind === 'api' && trigger.keyHint ? (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Key ends in …{trigger.keyHint} (shown once when created)
                    </p>
                  ) : null}
                  {trigger.lastError ? (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      Last problem: {trigger.lastError}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label="Remove trigger"
                  className="shrink-0 rounded p-1 text-gray-400 hover:text-red-600"
                >
                  ✕
                </button>
              </div>

              {trigger.draft.kind === 'schedule' ? (
                <div className="mt-2">
                  <SchedulePicker
                    value={trigger.draft.recurrence}
                    onChange={(recurrence) =>
                      update(index, {
                        kind: 'schedule',
                        recurrence,
                        timezone:
                          trigger.draft.kind === 'schedule'
                            ? trigger.draft.timezone
                            : defaultTimezone(),
                      })
                    }
                  />
                </div>
              ) : null}

              {trigger.draft.kind === 'api' ? (
                <ApiInputsEditor
                  inputs={trigger.draft.inputs}
                  onChange={(inputs) => update(index, { kind: 'api', inputs })}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {choosing ? (
        <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            When something happens
          </p>
          <div className="flex flex-wrap gap-2">
            {TRIGGER_EVENT_CATALOG.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => add({ kind: 'event', eventId: event.id })}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-left text-sm hover:border-blue-500 dark:border-gray-700"
                title={event.description}
              >
                {event.label}
              </button>
            ))}
          </div>
          <p className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Other ways
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                add({
                  kind: 'schedule',
                  recurrence: { every: 'day', at: '09:00' },
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
                  if (event.target.value) add({ kind: 'agent', callerAgentId: event.target.value });
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
              onClick={() => add({ kind: 'api', inputs: [] })}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:border-blue-500 dark:border-gray-700"
            >
              From an API call
            </button>
          </div>
          <button
            type="button"
            onClick={() => setChoosing(false)}
            className="mt-3 text-xs text-gray-500 hover:underline"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setChoosing(true)}
          className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add a trigger
        </button>
      )}

      {issues.length > 0 ? (
        <ul className="space-y-1">
          {issues.map((issue) => (
            <li key={issue} className="text-xs text-red-600 dark:text-red-400">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ApiInputsEditor({
  inputs,
  onChange,
}: {
  inputs: { name: string; label: string }[];
  onChange: (inputs: { name: string; label: string }[]) => void;
}) {
  const [name, setName] = useState('');
  return (
    <div className="mt-2">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Name the pieces of information a caller will send; your steps can then use them.
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {inputs.map((input) => (
          <span
            key={input.name}
            className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-xs text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300"
          >
            {input.name}
            <button
              type="button"
              aria-label={`Remove ${input.name}`}
              onClick={() => onChange(inputs.filter((entry) => entry.name !== input.name))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className={inputClass}
          value={name}
          placeholder="e.g. workItem"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed || inputs.some((entry) => entry.name === trimmed)) return;
            onChange([...inputs, { name: trimmed, label: trimmed }]);
            setName('');
          }}
        />
      </div>
    </div>
  );
}
