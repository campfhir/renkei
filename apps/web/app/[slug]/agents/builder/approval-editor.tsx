'use client';

/**
 * The editor-panel body for an approval (pause) node: the question, the
 * mode (approve/decline vs a typed answer), how long the run may wait,
 * and how the owner hears about it. The three outcome paths' STEPS are
 * edited on the canvas, where they render as labeled rows — here only
 * their names are edited, mirroring the branch editor.
 */

import type { ApprovalStep, BranchPath } from '@renkei/agents';
import { APPROVAL_OUTCOME_KEYS, type ApprovalOutcomeKey } from '@renkei/agents';
import { ChipEditor } from './chip-editor';
import type { VariableOption } from './options';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';

/** Preset waits; the select shows hours under the hood. */
const WAIT_PRESETS: { hours: number; label: string }[] = [
  { hours: 4, label: '4 hours' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 7 * 24, label: '7 days' },
  { hours: 14 * 24, label: '14 days' },
];

const OUTCOME_CAPTIONS: Record<ApprovalOutcomeKey, { approve: string; input: string }> = {
  onApproved: { approve: 'If approved', input: 'If answered' },
  onDeclined: { approve: 'If declined', input: 'If stopped' },
  onTimeout: { approve: 'If nobody acts', input: 'If nobody acts' },
};

export function ApprovalEditor({
  approval,
  onChange,
  variables,
  invalidVars,
  issues,
}: {
  approval: ApprovalStep;
  onChange: (approval: ApprovalStep) => void;
  variables: VariableOption[];
  invalidVars?: ReadonlySet<string>;
  issues: string[];
}) {
  const renamePath = (key: ApprovalOutcomeKey, name: string) => {
    const path: BranchPath = { ...approval[key], name };
    onChange({ ...approval, [key]: path });
  };

  const presetValues = new Set(WAIT_PRESETS.map((preset) => preset.hours));

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`approval-name-${approval.id}`}>
          Name this approval
        </label>
        <input
          id={`approval-name-${approval.id}`}
          className={inputClass}
          value={approval.name}
          maxLength={80}
          placeholder="e.g. OK to send the report?"
          onChange={(event) => onChange({ ...approval, name: event.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The run PAUSES here and puts a card on your home page. It continues down one of the
          paths below when you act — or down the timed-out path when the wait runs out.
        </p>
      </div>

      <div>
        <label className={labelClass}>What should it ask you?</label>
        <ChipEditor
          value={approval.message}
          onChange={(message) => onChange({ ...approval, message })}
          // No tools: the message is shown to the owner as written.
          tools={[]}
          variables={variables}
          maxTools={0}
          placeholder="What you'll see on the card — type / to include a saved detail"
          ariaLabel={`Message of approval ${approval.name || 'unnamed'}`}
          invalidVars={invalidVars}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Shown on the card with saved details filled in from the run — so you decide with the
          context in front of you.
        </p>
      </div>

      <fieldset>
        <legend className={labelClass}>What kind of answer?</legend>
        <div className="space-y-2">
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${
              approval.mode === 'approve'
                ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/30'
                : 'border-gray-200 dark:border-gray-800'
            }`}
          >
            <input
              type="radio"
              name={`approval-mode-${approval.id}`}
              className="mt-0.5"
              checked={approval.mode === 'approve'}
              onChange={() => {
                const { saveAs: _saveAs, ...rest } = approval;
                onChange({ ...rest, mode: 'approve' });
              }}
            />
            <span>
              <span className="font-medium">Approve or decline</span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                Two buttons on the card. Approving takes the first path, declining the second.
              </span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${
              approval.mode === 'input'
                ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/30'
                : 'border-gray-200 dark:border-gray-800'
            }`}
          >
            <input
              type="radio"
              name={`approval-mode-${approval.id}`}
              className="mt-0.5"
              checked={approval.mode === 'input'}
              onChange={() => onChange({ ...approval, mode: 'input' })}
            />
            <span>
              <span className="font-medium">Ask me to type an answer</span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                A text box on the card; the answer is saved for later steps to use.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {approval.mode === 'input' ? (
        <div>
          <label className={labelClass} htmlFor={`approval-saveas-${approval.id}`}>
            Name the answer
          </label>
          <input
            id={`approval-saveas-${approval.id}`}
            className={inputClass}
            value={approval.saveAs ?? ''}
            maxLength={64}
            placeholder="e.g. the decision"
            onChange={(event) =>
              onChange({ ...approval, saveAs: event.target.value || undefined })
            }
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Later steps reference it as a chip, like any saved result.
          </p>
        </div>
      ) : null}

      <div>
        <label className={labelClass} htmlFor={`approval-wait-${approval.id}`}>
          How long may it wait?
        </label>
        <select
          id={`approval-wait-${approval.id}`}
          className={inputClass}
          value={approval.timeoutHours}
          onChange={(event) =>
            onChange({ ...approval, timeoutHours: Number(event.target.value) })
          }
        >
          {!presetValues.has(approval.timeoutHours) ? (
            <option value={approval.timeoutHours}>{approval.timeoutHours} hours</option>
          ) : null}
          {WAIT_PRESETS.map((preset) => (
            <option key={preset.hours} value={preset.hours}>
              {preset.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          When the wait runs out, the run takes the timed-out path instead of stalling forever.
          Your organization caps the wait; longer choices are clipped to that cap on save.
        </p>
      </div>

      <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <span className={labelClass}>Tell me the card is waiting</span>
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={approval.notifyEmail}
              onChange={(event) => onChange({ ...approval, notifyEmail: event.target.checked })}
            />
            Email me the message and a link (from your own Outlook connection)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={approval.notifyWebex}
              onChange={(event) => onChange({ ...approval, notifyWebex: event.target.checked })}
            />
            WebEx note to self
          </label>
        </div>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          Either way the card is on your home page (and the run page) until you act.
        </p>
      </div>

      <div>
        <span className={labelClass}>Outcome paths</span>
        <ul className="space-y-2">
          {APPROVAL_OUTCOME_KEYS.map((key) => (
            <li key={key} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                {OUTCOME_CAPTIONS[key][approval.mode]}
              </span>
              <input
                aria-label={`Name of the ${OUTCOME_CAPTIONS[key][approval.mode]} path`}
                className={inputClass}
                value={approval[key].name}
                maxLength={80}
                onChange={(event) => renamePath(key, event.target.value)}
              />
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Each path's steps are edited on the canvas. An empty path just continues below the
          approval; put an End marker inside a path to stop the whole run there.
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
