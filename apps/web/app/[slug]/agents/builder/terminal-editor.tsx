'use client';

/**
 * The editor-panel body for a terminal (end marker) node: how the run ends
 * when it reaches this point, and what — if anything — gets sent to the
 * owner about it. The message is a chip editor with var chips so the
 * notification carries the run's real values ("Ticket [the ticket] could
 * not be updated"), which is exactly what the old generic failure mail
 * lacked; tool chips are deliberately not offered — an ending delivers,
 * it doesn't act.
 */

import type { TerminalResult, TerminalStep } from '@renkei/agents';
import { ChipEditor } from './chip-editor';
import type { VariableOption } from './options';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';

const RESULTS: { value: TerminalResult; label: string; hint: string }[] = [
  {
    value: 'success',
    label: 'Finish successfully',
    hint: 'The run ends here as done — automations chained after this agent still start.',
  },
  {
    value: 'failure',
    label: 'Fail the run',
    hint: 'The run records as failed. Only the notifications you pick below are sent — the generic failure email is skipped for endings you configure here.',
  },
  {
    value: 'stop',
    label: 'Stop — nothing to do',
    hint: 'The graceful early exit: not a success, emphatically not a failure. Nothing chains afterward.',
  },
];

export function TerminalEditor({
  terminal,
  onChange,
  variables,
  invalidVars,
  issues,
}: {
  terminal: TerminalStep;
  onChange: (terminal: TerminalStep) => void;
  variables: VariableOption[];
  invalidVars?: ReadonlySet<string>;
  issues: string[];
}) {
  const notifies = terminal.notifyEmail || terminal.notifyWebex;
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`terminal-name-${terminal.id}`}>
          Name this ending
        </label>
        <input
          id={`terminal-name-${terminal.id}`}
          className={inputClass}
          value={terminal.name}
          maxLength={80}
          placeholder="e.g. Ticket could not be updated"
          onChange={(event) => onChange({ ...terminal, name: event.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          When the flow reaches this marker the WHOLE run ends here — inside a branch path or a
          loop too. Useful as a deliberate exit on a path that means “we’re done” or “this went
          wrong”.
        </p>
      </div>

      <fieldset>
        <legend className={labelClass}>How does the run end?</legend>
        <div className="space-y-2">
          {RESULTS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${
                terminal.result === option.value
                  ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/30'
                  : 'border-gray-200 dark:border-gray-800'
              }`}
            >
              <input
                type="radio"
                name={`terminal-result-${terminal.id}`}
                className="mt-0.5"
                checked={terminal.result === option.value}
                onChange={() => onChange({ ...terminal, result: option.value })}
              />
              <span>
                <span className="font-medium">{option.label}</span>
                <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  {option.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <span className={labelClass}>Tell me when this happens</span>
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={terminal.notifyEmail}
              onChange={(event) => onChange({ ...terminal, notifyEmail: event.target.checked })}
            />
            Email me (sent from your own Outlook connection)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={terminal.notifyWebex}
              onChange={(event) => onChange({ ...terminal, notifyWebex: event.target.checked })}
            />
            WebEx note to self
          </label>
        </div>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          A channel that isn’t connected is skipped — the run page always shows the ending either
          way.
        </p>
      </div>

      <div>
        <label className={labelClass}>{notifies ? 'The message' : 'Message (optional)'}</label>
        <ChipEditor
          value={terminal.message}
          onChange={(message) => onChange({ ...terminal, message })}
          // No tools: an ending delivers a message, it doesn't act.
          tools={[]}
          variables={variables}
          maxTools={0}
          placeholder="What should the notification say — type / to include a saved detail"
          ariaLabel={`Message of ending ${terminal.name || 'unnamed'}`}
          invalidVars={invalidVars}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Sent as written, with saved details filled in from this run — so the notification carries
          the context (which ticket, which email, what failed), not just “an agent failed”.
        </p>
      </div>

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
