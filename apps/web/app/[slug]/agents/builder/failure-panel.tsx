'use client';

/**
 * Outcome lines — "when this happens, here is what should happen next",
 * written mostly in prose.
 *
 * One line per condition the author actually plans for (not a switch-row
 * per enumerated code): a condition chip, a free-text instruction the step
 * model reads (chips allowed), and compact controls for the part that must
 * stay deterministic — the routing action, and on retry the shared tries
 * budget plus the after-every-try choice. Conditions come from the tool's
 * enumerated outcomes OR from the author ("+ add outcome" → a custom
 * condition with a "when …" description the model classifies against by
 * reasoning over the result — a technically-successful call whose result
 * matches the description IS the condition).
 *
 * The default stays the safe one: an unhandled condition stops the agent,
 * said out loud in the muted last line rather than implied by absence.
 * Prose on a retry line is the corrective guidance (required, runs on
 * retries with its tool chips offered); prose on any other line is an
 * advisory note rendered into the attempt-1 outcome guide. An emptied
 * note emits its entry WITHOUT the guidance key, so untouched old agents
 * round-trip unchanged.
 */

import { useState } from 'react';
import {
  customOutcomeSlug,
  instructionPreview,
  type FailureHandling,
  type InstructionSegment,
} from '@renkei/agents';
import type { ToolOutcomes } from '@/lib/mcp-tools/outcomes';
import { ChipEditor } from './chip-editor';
import { useNumericInput } from '@/lib/use-numeric-input';
import { FieldIssues, forField, type NodeIssue } from './field-issues';
import type { ToolOption, VariableOption } from './options';

const CORRECTIVE_TOOL_LIMIT = 10;

export interface FailurePanelProps {
  /** The org's ceiling on tries — the select offers exactly this many. */
  attemptsCap: number;
  outcomes: ToolOutcomes;
  handling: FailureHandling[];
  onChange: (handling: FailureHandling[]) => void;
  maxAttempts: number;
  onMaxAttemptsChange: (attempts: number) => void;
  /** What success leads to — explicit, like every outcome line. */
  onSuccess: 'continue' | 'stop' | 'stop-quiet';
  onOnSuccessChange: (next: 'continue' | 'stop' | 'stop-quiet') => void;
  tools: ToolOption[];
  variables: VariableOption[];
  invalidVars?: ReadonlySet<string>;
  /**
   * Validation issues scoped to this step's handling, fields relative to
   * the step ('failureHandling' or 'failureHandling.N') — each line shows
   * and outlines its own.
   */
  issues?: NodeIssue[];
}

/** An emptied note must not survive as `guidance: []` — see the header. */
function emptyProse(segments: InstructionSegment[]): boolean {
  return segments.length === 0 || instructionPreview(segments).trim() === '';
}

export function FailurePanel({
  attemptsCap,
  outcomes,
  handling,
  onChange,
  maxAttempts,
  onMaxAttemptsChange,
  onSuccess,
  onOnSuccessChange,
  tools,
  variables,
  invalidVars,
  issues = [],
}: FailurePanelProps) {
  const [adding, setAdding] = useState(false);
  const [customWhen, setCustomWhen] = useState('');
  const [customOpen, setCustomOpen] = useState(false);

  const enumeratedByCode = new Map(outcomes.failures.map((failure) => [failure.code, failure]));
  const handledCodes = new Set(handling.map((entry) => entry.outcome));
  const unhandled = outcomes.failures.filter((failure) => !handledCodes.has(failure.code));

  const replaceEntry = (code: string, entry: FailureHandling | null) => {
    onChange(
      entry === null
        ? handling.filter((existing) => existing.outcome !== code)
        : handling.map((existing) => (existing.outcome === code ? entry : existing))
    );
  };

  const appendEntry = (entry: FailureHandling) => onChange([...handling, entry]);

  const addCustom = () => {
    const when = customWhen.trim();
    if (!when) return;
    let code = customOutcomeSlug(when) || 'condition';
    const taken = new Set([...enumeratedByCode.keys(), ...handledCodes, 'other']);
    if (taken.has(code)) {
      let suffix = 2;
      while (taken.has(`${code}-${suffix}`)) suffix += 1;
      code = `${code}-${suffix}`;
    }
    appendEntry({ outcome: code, action: 'exit', when });
    setCustomWhen('');
    setCustomOpen(false);
    setAdding(false);
  };

  // A number field, not a select: the option list would be exactly as long as
  // the org's ceiling, and that ceiling is an admin setting accepting up to
  // 100. Ten options scroll acceptably; a hundred is a scrollbar to hunt
  // through for a number the author already knows. Clamping happens on blur
  // (see useNumericInput) so it never fights the keystrokes.
  const triesField = useNumericInput(maxAttempts, onMaxAttemptsChange, (candidate) =>
    Math.min(Math.max(Math.round(candidate), 1), Math.max(1, attemptsCap))
  );
  const tries = (
    <span className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
      <span aria-hidden="true">×</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={Math.max(1, attemptsCap)}
        aria-label="Total tries for this step"
        title={`Tries are shared by every retrying condition of this step — ${attemptsCap} is your organization's ceiling.`}
        {...triesField}
        onChange={(event) => triesField.onChange(event.target.value)}
        className="w-14 rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
      />
      {maxAttempts === 1 ? 'try' : 'tries'}
    </span>
  );

  // No border of its own — the step editor's disclosure provides the frame.
  return (
    <div className="mt-3">
      {/* The success line: same grammar as every other outcome line. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-950">
        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
          ✓ {outcomes.success.label}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">then</span>
        <select
          value={onSuccess}
          aria-label="What success leads to"
          onChange={(event) => {
            const choice = event.target.value;
            onOnSuccessChange(choice === 'stop' || choice === 'stop-quiet' ? choice : 'continue');
          }}
          className="rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
        >
          <option value="continue">continue to the next step</option>
          <option value="stop">stop — done (replies still happen)</option>
          <option value="stop-quiet">stop silently (history only)</option>
        </select>
      </div>

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
        If something goes wrong
      </p>
      {/* Handling-wide issues (e.g. "this step has no skill") — anything
          entry-scoped renders inside its own line below. */}
      <FieldIssues
        messages={issues.filter((i) => i.field === 'failureHandling').map((i) => i.message)}
      />
      <ul className="mt-2 space-y-2">
        {handling.map((entry, index) => {
          const enumerated = enumeratedByCode.get(entry.outcome);
          const isCustom = entry.when !== undefined;
          const label = enumerated?.label ?? entry.outcome;
          const retriable = isCustom || enumerated === undefined || enumerated.retriable;
          const isRetry = entry.action === 'retry';
          const entryIssues = forField(issues, `failureHandling.${index}`);
          return (
            <li
              key={entry.outcome}
              data-outcome-line
              className={`rounded-md border bg-white p-2 dark:bg-gray-950 ${
                entryIssues.length > 0
                  ? 'border-red-400 dark:border-red-700'
                  : 'border-gray-200 dark:border-gray-800'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  title={entry.when ?? enumerated?.description}
                  className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                >
                  {label}
                  <button
                    type="button"
                    aria-label={`Stop handling "${label}"`}
                    title="Remove this line — the condition goes back to the default (stop the agent)."
                    onClick={() => replaceEntry(entry.outcome, null)}
                    className="ml-0.5 text-amber-700 hover:text-amber-900 dark:text-amber-400"
                  >
                    ×
                  </button>
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <select
                    value={entry.action}
                    aria-label={`What happens on "${label}"`}
                    onChange={(event) => {
                      const action = event.target.value;
                      const keepWhen = entry.when !== undefined ? { when: entry.when } : {};
                      if (action === 'retry') {
                        replaceEntry(entry.outcome, {
                          outcome: entry.outcome,
                          action: 'retry',
                          guidance: entry.guidance ?? [],
                          ...keepWhen,
                        });
                        return;
                      }
                      // Off retry: the exhausted choice no longer applies;
                      // the prose survives as an advisory note (or is
                      // omitted when empty).
                      const prose =
                        entry.guidance !== undefined && !emptyProse(entry.guidance)
                          ? { guidance: entry.guidance }
                          : {};
                      replaceEntry(entry.outcome, {
                        outcome: entry.outcome,
                        action: action === 'continue' || action === 'stop-quiet' ? action : 'exit',
                        ...prose,
                        ...keepWhen,
                      });
                    }}
                    className="rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                  >
                    <option value="exit">stop the agent</option>
                    <option
                      value="retry"
                      disabled={!retriable}
                      title={retriable ? undefined : "Retrying won't help here."}
                    >
                      try again
                    </option>
                    <option
                      value="continue"
                      title="Note the failure and move on — the step's saved result becomes the failure summary, so later steps can see what happened."
                    >
                      keep going anyway
                    </option>
                    <option
                      value="stop-quiet"
                      title="Not an error: the run ends silently — no reply, no notification, no follow-up automations — and shows as skipped."
                    >
                      not an error — stop silently
                    </option>
                  </select>
                  {isRetry ? (
                    <>
                      {tries}
                      <span className="text-xs text-gray-500 dark:text-gray-400">then</span>
                      <select
                        value={entry.exhausted ?? 'exit'}
                        aria-label={`When every try fails on "${label}"`}
                        onChange={(event) => {
                          const choice = event.target.value;
                          const base: FailureHandling = {
                            outcome: entry.outcome,
                            action: 'retry',
                            guidance: entry.guidance ?? [],
                            ...(entry.when !== undefined ? { when: entry.when } : {}),
                          };
                          replaceEntry(
                            entry.outcome,
                            choice === 'continue' || choice === 'stop-quiet'
                              ? { ...base, exhausted: choice }
                              : base
                          );
                        }}
                        className="rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                      >
                        <option value="exit">stop the agent</option>
                        <option value="continue">keep going anyway</option>
                        <option value="stop-quiet">end quietly — skipped</option>
                      </select>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="mt-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 dark:border-gray-800 dark:bg-gray-900/60">
                <ChipEditor
                  frameless
                  value={entry.guidance ?? []}
                  onChange={(guidance) => {
                    // Retry keeps its guidance verbatim (the validator
                    // demands text); elsewhere an emptied note drops the key.
                    const prose = isRetry || !emptyProse(guidance) ? { guidance } : {};
                    const { guidance: _drop, ...rest } = entry;
                    replaceEntry(entry.outcome, { ...rest, ...prose });
                  }}
                  tools={tools}
                  variables={variables}
                  maxTools={CORRECTIVE_TOOL_LIMIT}
                  placeholder={
                    isRetry
                      ? 'What should it do differently? e.g. Search by the summary text instead'
                      : 'What should happen next? (an optional note the agent reads)'
                  }
                  ariaLabel={`What to do when ${label.toLowerCase()}`}
                  invalidVars={invalidVars}
                />
              </div>
              {isCustom ? (
                <div className="mt-1.5 flex items-center gap-2">
                  <label className="shrink-0 text-xs font-medium text-gray-600 dark:text-gray-400">
                    when…
                  </label>
                  <input
                    type="text"
                    value={entry.when ?? ''}
                    aria-label={`When does "${label}" apply?`}
                    onChange={(event) =>
                      replaceEntry(entry.outcome, { ...entry, when: event.target.value })
                    }
                    placeholder="describe when this condition applies — the agent judges it over the result"
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                  />
                </div>
              ) : null}
              <FieldIssues messages={entryIssues} />
            </li>
          );
        })}
        <li className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-gray-500 dark:text-gray-400">
          <span>Anything unhandled stops the agent.</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setAdding((open) => !open);
                setCustomOpen(false);
              }}
              className="font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              + Add an outcome
            </button>
            {adding ? (
              <div className="absolute right-0 z-10 mt-1 w-80 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                {unhandled.map((failure) => (
                  <button
                    key={failure.code}
                    type="button"
                    onClick={() => {
                      appendEntry({ outcome: failure.code, action: 'exit' });
                      setAdding(false);
                    }}
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <span className="block text-sm text-gray-800 dark:text-gray-200">
                      {failure.label}
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {failure.description}
                    </span>
                  </button>
                ))}
                {customOpen ? (
                  <div className="border-t border-gray-100 p-2 dark:border-gray-800">
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      Your own condition — when does it apply?
                    </label>
                    <input
                      type="text"
                      autoFocus
                      value={customWhen}
                      onChange={(event) => setCustomWhen(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addCustom();
                        }
                      }}
                      placeholder="e.g. results exist but none match the description closely enough"
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                    />
                    <button
                      type="button"
                      onClick={addCustom}
                      disabled={!customWhen.trim()}
                      className="mt-1.5 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Add condition
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCustomOpen(true)}
                    className="block w-full rounded border-t border-gray-100 px-2 py-1.5 text-left text-sm font-medium text-blue-600 hover:bg-gray-100 dark:border-gray-800 dark:text-blue-400 dark:hover:bg-gray-800"
                  >
                    Custom condition…
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </li>
      </ul>
    </div>
  );
}
