'use client';

/**
 * The flow chart's start cluster — "When should it run?" as the first node.
 * Each trigger is one collapsed row; clicking a row opens the editor panel
 * on that trigger, "+ Add a trigger" opens it in chooser mode. The rows
 * also teach the trigger.* chip vocabulary via the violet provides-chips.
 */

import {
  describeSchedule,
  describeTriggerMatch,
  triggerEventById,
  type TriggerDraft,
} from '@renkei/agents';
import type { TriggerPayload } from '@/lib/agents/store';
import { FixedRail } from './fixed-marker';

export interface AgentChoice {
  id: string;
  name: string;
}

/** The payload shape plus the read-only decorations a stored row carries. */
export type BuilderTrigger = TriggerPayload & {
  keyHint?: string | null;
  lastError?: string | null;
};

export function providesOf(draft: TriggerDraft): string[] {
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

/**
 * The trigger's deterministic narrowing, as a phrase, or null when it runs
 * on everything. The same sentence the filter panel prints — one
 * implementation in `@renkei/agents`, so the card and the editor cannot
 * describe one filter two ways.
 */
export function filterSummaryOf(draft: TriggerDraft): string | null {
  if (draft.kind !== 'event') return null;
  return describeTriggerMatch(draft.eventId, draft.match ?? {});
}

export function summaryOf(draft: TriggerDraft, otherAgents: AgentChoice[]): string {
  switch (draft.kind) {
    case 'event':
      return triggerEventById(draft.eventId)?.label ?? draft.eventId;
    case 'schedule':
      // The shared humanizer — the same prose the LLM description uses.
      return describeSchedule(draft);
    case 'agent': {
      const name = otherAgents.find((agent) => agent.id === draft.callerAgentId)?.name;
      return `After “${name ?? 'another agent'}” finishes successfully`;
    }
    case 'api':
      return 'From an API call';
  }
}

export function TriggerNode({
  triggers,
  otherAgents,
  selectedIndex,
  issues,
  onSelect,
  onAdd,
}: {
  triggers: BuilderTrigger[];
  otherAgents: AgentChoice[];
  /** Which trigger row is open in the editor panel, if any. */
  selectedIndex: number | null;
  issues: string[];
  onSelect: (index: number) => void;
  onAdd: () => void;
}) {
  return (
    <div className="relative w-80 rounded-xl border border-gray-300 bg-gray-50 p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      {/*
        The whole trigger layer is deterministic — a schedule, a webhook, a
        filter — so the rail belongs on the cluster rather than on each row.
        It also makes the shape of a run legible down the canvas: a fixed
        head, a model-calling body, fixed ends.
      */}
      <FixedRail />
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <span aria-hidden="true">⚡</span> When should it run?
      </p>
      {triggers.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Nothing starts this agent yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {triggers.map((trigger, index) => (
            <li key={trigger.id ?? `new-${index}`}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                className={`w-full rounded-md border bg-white p-2 text-left dark:bg-gray-950 ${
                  selectedIndex === index
                    ? 'border-blue-500 ring-2 ring-blue-500'
                    : 'border-gray-200 hover:border-blue-400 dark:border-gray-800'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {trigger.lastError ? (
                    <span
                      title={`Last problem: ${trigger.lastError}`}
                      className="h-2 w-2 shrink-0 rounded-full bg-red-500"
                    />
                  ) : null}
                  <span className="min-w-0 truncate text-sm font-medium">
                    {summaryOf(trigger.draft, otherAgents)}
                  </span>
                </span>
                <span className="mt-1 flex items-center gap-1 overflow-hidden text-xs text-gray-500">
                  <span className="shrink-0">gives:</span>
                  <span className="truncate">{providesOf(trigger.draft).join(' · ') || '—'}</span>
                </span>
                {/*
                  Only when the trigger is actually narrowed. An unfiltered
                  trigger saying "only when: everything" would be a line of
                  chrome on every card that never means anything.
                */}
                {filterSummaryOf(trigger.draft) ? (
                  <span className="mt-0.5 flex items-center gap-1 overflow-hidden text-xs text-gray-500">
                    <span aria-hidden="true" className="shrink-0">
                      ▽
                    </span>
                    <span className="truncate">only {filterSummaryOf(trigger.draft)}</span>
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        + Add a trigger
      </button>
      {issues.length > 0 ? (
        <ul className="mt-1 space-y-1">
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
