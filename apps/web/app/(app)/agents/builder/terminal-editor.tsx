'use client';

/**
 * The editor-panel body for a terminal (end marker) node: how the run ends
 * when it reaches this point, and an optional note on why. The message is a
 * chip editor with var chips so the note carries the run's real values
 * ("Ticket [the ticket] could not be updated"); tool chips are deliberately
 * not offered — an ending describes, it doesn't act.
 *
 * This node used to also carry its own "email/WebEx me" switches. Removed:
 * they duplicated (and could silently disagree with) the owner's own
 * Preferences, which is now the one place that decides what reaches someone
 * and how — see @renkei/user-prefs.
 */

import type { TerminalResult, TerminalStep } from '@renkei/agents';
import { ChipEditor } from './chip-editor';
import { FieldIssues, exceptFields, fieldClass, forField, type NodeIssue } from './field-issues';
import type { VariableOption } from './options';

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
    hint: 'The run records as failed, same as any other failure — reflected in the owner’s own Preferences, not configured here.',
  },
  {
    value: 'stop',
    label: 'Skip the rest',
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
  issues: NodeIssue[];
}) {
  const nameIssues = forField(issues, 'name');
  const messageIssues = forField(issues, 'message');
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`terminal-name-${terminal.id}`}>
          Name this ending
        </label>
        <input
          id={`terminal-name-${terminal.id}`}
          className={fieldClass(nameIssues.length > 0)}
          aria-invalid={nameIssues.length > 0 || undefined}
          value={terminal.name}
          maxLength={80}
          placeholder="e.g. Ticket could not be updated"
          onChange={(event) => onChange({ ...terminal, name: event.target.value })}
        />
        <FieldIssues messages={nameIssues} />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          When the flow reaches this marker the WHOLE run ends here — inside a branch path or a loop
          too. Useful as a deliberate exit on a path that means “we’re done” or “this went wrong”.
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

      <div>
        <label className={labelClass}>Message (optional)</label>
        <ChipEditor
          value={terminal.message}
          onChange={(message) => onChange({ ...terminal, message })}
          // No tools: an ending delivers a message, it doesn't act.
          tools={[]}
          variables={variables}
          maxTools={0}
          placeholder="What should this ending say — type / to include a saved detail"
          ariaLabel={`Message of ending ${terminal.name || 'unnamed'}`}
          invalidVars={invalidVars}
          invalid={messageIssues.length > 0}
        />
        <FieldIssues messages={messageIssues} />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Shown on the run&rsquo;s own timeline, with saved details filled in from this run — so it
          carries real context (which ticket, which email, what failed), not just “an agent failed”.
          Whether anyone is told about this run at all is controlled in that person&rsquo;s own
          Preferences, not here.
        </p>
      </div>

      <FieldIssues messages={exceptFields(issues, 'name', 'message')} />
    </div>
  );
}
