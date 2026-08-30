'use client';

/**
 * The editor-panel body for an approval (pause) node: the question, the
 * mode (approve/decline vs a typed answer), how long the run may wait,
 * and how the owner hears about it. The three outcome paths' STEPS are
 * edited on the canvas, where they render as labeled rows — here only
 * their names are edited, mirroring the branch editor.
 */

import type { ApprovalField, ApprovalFieldType, ApprovalStep, BranchPath } from '@renkei/agents';
import {
  APPROVAL_OUTCOME_KEYS,
  MAX_APPROVAL_FIELDS,
  approvalFieldsOf,
  type ApprovalOutcomeKey,
} from '@renkei/agents';
import { ChipEditor } from './chip-editor';
import { FieldIssues, exceptFields, fieldClass, forField, type NodeIssue } from './field-issues';
import type { VariableOption } from './options';

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
  onDeclined: { approve: 'If declined', input: 'If skipped' },
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
  issues: NodeIssue[];
}) {
  const renamePath = (key: ApprovalOutcomeKey, name: string) => {
    const path: BranchPath = { ...approval[key], name };
    onChange({ ...approval, [key]: path });
  };

  const presetValues = new Set(WAIT_PRESETS.map((preset) => preset.hours));
  const nameIssues = forField(issues, 'name');
  const messageIssues = forField(issues, 'message');
  const saveAsIssues = forField(issues, 'saveAs');
  const fields = approvalFieldsOf(approval);
  const fieldsIssues = forField(issues, 'fields');
  const timeoutIssues = forField(issues, 'timeoutHours');
  const otherIssues = exceptFields(
    issues,
    'name',
    'message',
    'saveAs',
    'fields',
    'timeoutHours',
    ...APPROVAL_OUTCOME_KEYS
  );

  /** Replace one field in place — the editor's only mutation shape. */
  const setField = (index: number, next: ApprovalField) => {
    onChange({ ...approval, fields: fields.map((field, at) => (at === index ? next : field)) });
  };
  const addField = () => {
    const next: ApprovalField = { name: '', label: '', type: 'text', required: true };
    // The first field takes over from the plain box, so saveAs goes with
    // it: a step cannot both save one answer and collect several.
    const { saveAs: _saveAs, ...rest } = approval;
    onChange({ ...rest, fields: [...fields, next] });
  };
  const removeField = (index: number) => {
    const remaining = fields.filter((_field, at) => at !== index);
    if (remaining.length > 0) {
      onChange({ ...approval, fields: remaining });
      return;
    }
    // Back to one plain box — and it needs its name back, empty for the
    // author to fill, because the validator requires one.
    const { fields: _fields, ...rest } = approval;
    onChange({ ...rest, saveAs: '' });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`approval-name-${approval.id}`}>
          Name this approval
        </label>
        <input
          id={`approval-name-${approval.id}`}
          className={fieldClass(nameIssues.length > 0)}
          aria-invalid={nameIssues.length > 0 || undefined}
          value={approval.name}
          maxLength={80}
          placeholder="e.g. OK to send the report?"
          onChange={(event) => onChange({ ...approval, name: event.target.value })}
        />
        <FieldIssues messages={nameIssues} />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The run PAUSES here and puts a card on your home page. It continues down one of the paths
          below when you act — or down the timed-out path when the wait runs out.
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
          invalid={messageIssues.length > 0}
        />
        <FieldIssues messages={messageIssues} />
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
              <span className="font-medium">Ask me for an answer</span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                A text box on the card — or a form of specific things (a number, a date, a choice).
                Answers are saved for later steps to use.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {approval.mode === 'input' && fields.length === 0 ? (
        <div>
          <label className={labelClass} htmlFor={`approval-saveas-${approval.id}`}>
            Name the answer
          </label>
          <input
            id={`approval-saveas-${approval.id}`}
            className={fieldClass(saveAsIssues.length > 0)}
            aria-invalid={saveAsIssues.length > 0 || undefined}
            value={approval.saveAs ?? ''}
            maxLength={64}
            placeholder="e.g. the decision"
            onChange={(event) => onChange({ ...approval, saveAs: event.target.value || undefined })}
          />
          <FieldIssues messages={saveAsIssues} />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Later steps reference it as a chip, like any saved result.
          </p>
          <button
            type="button"
            onClick={addField}
            className="mt-2 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Ask for specific things instead →
          </button>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            A form on the card — a number, a date, a choice from a list — each saved under its own
            name, and each checked before the run continues.
          </p>
        </div>
      ) : null}

      {approval.mode === 'input' && fields.length > 0 ? (
        <div>
          <span className={labelClass}>What should the card ask for?</span>
          <FieldIssues messages={fieldsIssues} />
          <div className="space-y-2">
            {fields.map((field, index) => (
              <FieldRow
                // Position, not name: a field being renamed has a blank or
                // duplicate name for as long as the author is typing it.
                key={index}
                field={field}
                index={index}
                issues={forField(issues, `fields.${index}`)}
                onChange={(next) => setField(index, next)}
                onRemove={() => removeField(index)}
              />
            ))}
          </div>
          {fields.length < MAX_APPROVAL_FIELDS ? (
            <button
              type="button"
              onClick={addField}
              className="mt-2 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              + Ask for another
            </button>
          ) : (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              That is the most one card may ask for.
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Each answer is saved under its own name and available to later steps as a chip. Where
            the answer is headed somewhere with its own field id — a Jira custom field, say — put
            that id on the field and the step writing it gets the pair. Remove them all to go back
            to one plain answer.
          </p>
        </div>
      ) : null}

      <div>
        <label className={labelClass} htmlFor={`approval-wait-${approval.id}`}>
          How long may it wait?
        </label>
        <select
          id={`approval-wait-${approval.id}`}
          className={fieldClass(timeoutIssues.length > 0)}
          aria-invalid={timeoutIssues.length > 0 || undefined}
          value={approval.timeoutHours}
          onChange={(event) => onChange({ ...approval, timeoutHours: Number(event.target.value) })}
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
        <FieldIssues messages={timeoutIssues} />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          When the wait runs out, the run takes the timed-out path instead of stalling forever. Your
          organization caps the wait; longer choices are clipped to that cap on save.
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
          {APPROVAL_OUTCOME_KEYS.map((key) => {
            const pathIssues = forField(issues, key);
            return (
              <li key={key} className="flex flex-wrap items-center gap-2">
                <span className="w-24 shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                  {OUTCOME_CAPTIONS[key][approval.mode]}
                </span>
                <input
                  aria-label={`Name of the ${OUTCOME_CAPTIONS[key][approval.mode]} path`}
                  aria-invalid={pathIssues.length > 0 || undefined}
                  className={`min-w-0 flex-1 ${fieldClass(pathIssues.length > 0)}`}
                  value={approval[key].name}
                  maxLength={80}
                  onChange={(event) => renamePath(key, event.target.value)}
                />
                {pathIssues.length > 0 ? (
                  <div className="w-full pl-[6.5rem]">
                    <FieldIssues messages={pathIssues} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Each path's steps are edited on the canvas. An empty path just continues below the
          approval; put an End marker inside a path to stop the whole run there.
        </p>
      </div>

      <FieldIssues messages={otherIssues} />
    </div>
  );
}

const FIELD_TYPES: { value: ApprovalFieldType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'longtext', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'choice', label: 'One choice' },
  { value: 'multi', label: 'Several choices' },
];

/**
 * One field of the form, as a row in the editor panel.
 *
 * The PROMPT and the NAME are separate on purpose and both are asked for.
 * The prompt is what the person answering reads ("Which issue tracks this
 * work?"); the name is what a later step's chip says ("the issue key").
 * Deriving one from the other was tried on paper and reads badly at both
 * ends — a chip called "Which issue tracks this work?" in the middle of an
 * instruction, or a card asking for "the issue key" with no clue what that
 * means here.
 *
 * Options are edited as one per line rather than as rows with buttons: a
 * choice list is usually pasted from somewhere, and a textarea takes a
 * paste of eight lines as eight options.
 */
function FieldRow({
  field,
  index,
  issues,
  onChange,
  onRemove,
}: {
  field: ApprovalField;
  index: number;
  issues: string[];
  onChange: (field: ApprovalField) => void;
  onRemove: () => void;
}) {
  const choices = field.type === 'choice' || field.type === 'multi';
  const idFor = (part: string) => `approval-field-${index}-${part}`;

  const retype = (type: ApprovalFieldType) => {
    // Dropping the settings that no longer apply keeps a stored field from
    // carrying options nobody can see and the validator rejects.
    const { options: _options, min: _min, max: _max, ...rest } = field;
    onChange({
      ...rest,
      type,
      ...(type === 'choice' || type === 'multi' ? { options: field.options ?? [] } : {}),
      ...(type === 'number'
        ? {
            ...(field.min !== undefined ? { min: field.min } : {}),
            ...(field.max !== undefined ? { max: field.max } : {}),
          }
        : {}),
    });
  };

  return (
    <div className="rounded-md border border-gray-200 p-2 dark:border-gray-800">
      <div className="flex items-start gap-2">
        <span className="mt-2 text-xs font-medium text-gray-400">{index + 1}.</span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input
              aria-label={`What field ${index + 1} asks for`}
              className={`min-w-0 flex-1 ${fieldClass(issues.length > 0)}`}
              value={field.label}
              maxLength={200}
              placeholder="What to ask — e.g. Which issue tracks this?"
              onChange={(event) => onChange({ ...field, label: event.target.value })}
            />
            <select
              aria-label={`Kind of answer for field ${index + 1}`}
              className={`${fieldClass(false)} w-auto`}
              value={field.type}
              onChange={(event) => {
                const picked = FIELD_TYPES.find((entry) => entry.value === event.target.value);
                if (picked) retype(picked.value);
              }}
            >
              {FIELD_TYPES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400" htmlFor={idFor('name')}>
              Save as
            </label>
            <input
              id={idFor('name')}
              className={`min-w-0 flex-1 ${fieldClass(false)}`}
              value={field.name}
              maxLength={64}
              placeholder="e.g. the issue key"
              onChange={(event) => onChange({ ...field, name: event.target.value })}
            />
            <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) => onChange({ ...field, required: event.target.checked })}
              />
              Required
            </label>
          </div>

          {choices ? (
            <div>
              <label
                className="text-xs text-gray-500 dark:text-gray-400"
                htmlFor={idFor('options')}
              >
                Choices, one per line
              </label>
              <textarea
                id={idFor('options')}
                className={`${fieldClass(false)} mt-1`}
                rows={3}
                value={(field.options ?? []).join('\n')}
                placeholder={'CIO-12\nCIO-88\nNone of these'}
                onChange={(event) =>
                  onChange({ ...field, options: event.target.value.split('\n') })
                }
              />
            </div>
          ) : null}

          {field.type === 'number' ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-gray-500 dark:text-gray-400" htmlFor={idFor('min')}>
                Lowest
              </label>
              <input
                id={idFor('min')}
                type="number"
                className={`w-24 ${fieldClass(false)}`}
                value={field.min ?? ''}
                onChange={(event) =>
                  onChange({
                    ...field,
                    min: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
              />
              <label className="text-xs text-gray-500 dark:text-gray-400" htmlFor={idFor('max')}>
                Highest
              </label>
              <input
                id={idFor('max')}
                type="number"
                className={`w-24 ${fieldClass(false)}`}
                value={field.max ?? ''}
                onChange={(event) =>
                  onChange({
                    ...field,
                    max: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
              />
            </div>
          ) : null}

          <input
            aria-label={`Hint under field ${index + 1}`}
            className={fieldClass(false)}
            value={field.help ?? ''}
            maxLength={500}
            placeholder="Optional hint shown under the box"
            onChange={(event) => onChange({ ...field, help: event.target.value || undefined })}
          />

          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400" htmlFor={idFor('key')}>
              Field id where it&apos;s going
            </label>
            <input
              id={idFor('key')}
              className={`min-w-0 flex-1 ${fieldClass(false)}`}
              value={field.key ?? ''}
              maxLength={200}
              placeholder="Optional — e.g. customfield_10016"
              onChange={(event) => onChange({ ...field, key: event.target.value || undefined })}
            />
          </div>

          <FieldIssues messages={issues} />
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove field ${index + 1}`}
          title="Remove this field"
          className="mt-1 rounded-md p-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
