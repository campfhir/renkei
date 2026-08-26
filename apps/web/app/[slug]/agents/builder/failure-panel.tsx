'use client';

/**
 * "If something goes wrong" — one row per condition the step's tool
 * enumerates (the outcome metadata served with the tool catalog), each a
 * choice between stopping the agent, retrying with extra guidance,
 * declaring the condition benign ("ticket not found" is sometimes a
 * reason to skip the rest) — which ends the run silently as skipped, not
 * failed — and carrying on to the next step with the failure on record.
 *
 * The default is stop: an absent handling entry means exit, so a user who
 * configures nothing gets the safe behavior. Retry reveals a guidance
 * editor (chips allowed, tools allowed — several, deliberately laxer than
 * the step body, because fixing a failure may take extra lookups), plus a
 * choice of where to land when every try fails; the step-level attempts
 * selector caps everything at the org's ceiling.
 */

import type { FailureHandling } from '@renkei/agents';
import type { ToolOutcomes } from '@/lib/mcp-tools/outcomes';
import { ChipEditor } from './chip-editor';
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
  /** What success leads to — explicit, like every failure row. */
  onSuccess: 'continue' | 'stop' | 'stop-quiet';
  onOnSuccessChange: (next: 'continue' | 'stop' | 'stop-quiet') => void;
  tools: ToolOption[];
  variables: VariableOption[];
  invalidVars?: ReadonlySet<string>;
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
}: FailurePanelProps) {
  const byCode = new Map(handling.map((entry) => [entry.outcome, entry]));

  const setEntry = (code: string, entry: FailureHandling | null) => {
    const next = handling.filter((existing) => existing.outcome !== code);
    if (entry) next.push(entry);
    onChange(next);
  };

  const anyRetry = handling.some((entry) => entry.action === 'retry');

  // No border of its own — the step editor's disclosure provides the frame.
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          <span className="mr-1 text-green-600 dark:text-green-400">✓</span>
          When this works — <span className="font-medium">{outcomes.success.label}</span> —
        </p>
        <div className="flex overflow-hidden rounded-md border border-gray-300 text-xs dark:border-gray-700">
          <button
            type="button"
            onClick={() => onOnSuccessChange('continue')}
            className={`px-2.5 py-1 ${
              onSuccess === 'continue'
                ? 'bg-green-700 text-white'
                : 'text-gray-600 dark:text-gray-400'
            }`}
          >
            Continue to the next step
          </button>
          <button
            type="button"
            title="The automation finishes successfully here; later steps never run. Replies and follow-up automations still happen."
            onClick={() => onOnSuccessChange('stop')}
            className={`px-2.5 py-1 ${
              onSuccess === 'stop'
                ? 'bg-gray-700 text-white dark:bg-gray-300 dark:text-gray-900'
                : 'text-gray-600 dark:text-gray-400'
            }`}
          >
            Stop — done
          </button>
          <button
            type="button"
            title="Ends silently: no reply, no notification, no chained agents — only run history records it."
            onClick={() => onOnSuccessChange('stop-quiet')}
            className={`px-2.5 py-1 ${
              onSuccess === 'stop-quiet'
                ? 'bg-gray-700 text-white dark:bg-gray-300 dark:text-gray-900'
                : 'text-gray-600 dark:text-gray-400'
            }`}
          >
            Stop silently
          </button>
        </div>
      </div>

      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
        If something goes wrong
      </p>
      <ul className="mt-2 space-y-3">
        {outcomes.failures.map((failure) => {
          const entry = byCode.get(failure.code);
          const action = entry?.action ?? 'exit';
          return (
            <li key={failure.code}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-medium">{failure.label}</span>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{failure.description}</p>
                </div>
                <div className="flex overflow-hidden rounded-md border border-gray-300 text-xs dark:border-gray-700">
                  <button
                    type="button"
                    onClick={() => setEntry(failure.code, null)}
                    className={`px-2.5 py-1 ${
                      action === 'exit'
                        ? 'bg-gray-700 text-white dark:bg-gray-300 dark:text-gray-900'
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    Stop the agent
                  </button>
                  <button
                    type="button"
                    disabled={!failure.retriable}
                    title={failure.retriable ? undefined : "Retrying won't help here."}
                    onClick={() =>
                      setEntry(failure.code, {
                        ...entry,
                        outcome: failure.code,
                        action: 'retry',
                        guidance: entry?.guidance ?? [],
                      })
                    }
                    className={`px-2.5 py-1 ${
                      action === 'retry'
                        ? 'bg-blue-600 text-white'
                        : failure.retriable
                          ? 'text-gray-600 dark:text-gray-400'
                          : 'cursor-not-allowed text-gray-300 dark:text-gray-600'
                    }`}
                  >
                    Try again with extra guidance
                  </button>
                  <button
                    type="button"
                    title="Note the failure and move on to the next step anyway — the step's saved result becomes the failure summary, so later steps can see what happened."
                    onClick={() =>
                      setEntry(failure.code, { outcome: failure.code, action: 'continue' })
                    }
                    className={`px-2.5 py-1 ${
                      action === 'continue'
                        ? 'bg-gray-700 text-white dark:bg-gray-300 dark:text-gray-900'
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    Keep going anyway
                  </button>
                  <button
                    type="button"
                    title="Treat this as not an error: the run ends silently — no reply, no notification, no follow-up automations — and shows as skipped, not failed."
                    onClick={() =>
                      setEntry(failure.code, { outcome: failure.code, action: 'stop-quiet' })
                    }
                    className={`px-2.5 py-1 ${
                      action === 'stop-quiet'
                        ? 'bg-gray-700 text-white dark:bg-gray-300 dark:text-gray-900'
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    Not an error — stop silently
                  </button>
                </div>
              </div>
              {action === 'retry' ? (
                <div className="mt-2 space-y-2 pl-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                      What should it do differently? (This runs only when retrying.)
                    </label>
                    <ChipEditor
                      value={entry?.guidance ?? []}
                      onChange={(guidance) =>
                        setEntry(failure.code, {
                          ...entry,
                          outcome: failure.code,
                          action: 'retry',
                          guidance,
                        })
                      }
                      tools={tools}
                      variables={variables}
                      maxTools={CORRECTIVE_TOOL_LIMIT}
                      placeholder="e.g. Search by the summary text instead of the exact key"
                      ariaLabel={`Guidance when ${failure.label.toLowerCase()}`}
                      invalidVars={invalidVars}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      If every try still fails:
                    </span>
                    <select
                      value={entry?.exhausted ?? 'exit'}
                      aria-label={`When every try fails on ${failure.label.toLowerCase()}`}
                      onChange={(event) => {
                        const choice = event.target.value;
                        const base = {
                          outcome: failure.code,
                          action: 'retry' as const,
                          guidance: entry?.guidance ?? [],
                        };
                        setEntry(
                          failure.code,
                          choice === 'continue' || choice === 'stop-quiet'
                            ? { ...base, exhausted: choice }
                            : base
                        );
                      }}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
                    >
                      <option value="exit">Stop the agent</option>
                      <option value="continue">Keep going anyway</option>
                      <option value="stop-quiet">End quietly — skipped</option>
                    </select>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {anyRetry ? (
        <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
          <label className="text-sm text-gray-700 dark:text-gray-300" htmlFor="attempts">
            Give up after
          </label>
          <select
            id="attempts"
            value={maxAttempts}
            onChange={(event) => onMaxAttemptsChange(Number(event.target.value))}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {Array.from({ length: Math.max(1, attemptsCap) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n === 1 ? '1 try' : `${n} tries`}
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            counting the first one — {attemptsCap} is the most your organization allows
          </span>
        </div>
      ) : null}
    </div>
  );
}
