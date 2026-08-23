'use client';

/**
 * The editor-panel body for a loop node: name, the mode (for-each over a
 * saved list vs repeat-until a condition holds), its bounds, and the
 * optional collect-into-a-list section that turns the loop into a
 * map/filter. The BODY steps are edited on the canvas, inside the amber
 * container.
 */

import {
  flattenActionSteps,
  instructionPreview,
  LOOP_DEFAULT_ATTEMPTS,
  MAX_LOOP_ITERATIONS,
  type ForEachLoopStep,
  type LoopStep,
  type UntilLoopStep,
} from '@renkei/agents';
import { ChipEditor } from './chip-editor';
import type { VariableOption } from './options';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';

const ITERATION_CHOICES = [1, 2, 3, 5, 10, 15, 20, 25];

export function LoopEditor({
  loop,
  onChange,
  variables,
  invalidVars,
  issues,
}: {
  loop: LoopStep;
  onChange: (loop: LoopStep) => void;
  variables: VariableOption[];
  invalidVars?: ReadonlySet<string>;
  issues: string[];
}) {
  // The collect source must be a result saved INSIDE the body — offer
  // exactly those, which doubles as the explanation of the rule.
  const bodySaveNames = flattenActionSteps(loop.steps).flatMap((step) =>
    step.saveAs ? [step.saveAs] : []
  );

  const common = {
    id: loop.id,
    kind: 'loop' as const,
    name: loop.name,
    maxIterations: loop.maxIterations,
    ...(loop.collectFrom !== undefined && loop.collectVar !== undefined
      ? { collectFrom: loop.collectFrom, collectVar: loop.collectVar }
      : {}),
    steps: loop.steps,
  };

  const toForeach = (): ForEachLoopStep => ({
    ...common,
    mode: 'foreach',
    itemsVar: '',
    itemVar: 'item',
  });

  const toUntil = (): UntilLoopStep => ({
    ...common,
    mode: 'until',
    condition: [],
    maxAttempts: LOOP_DEFAULT_ATTEMPTS,
  });

  const setCollect = (on: boolean) => {
    if (on === (loop.collectVar !== undefined)) return;
    if (on) {
      onChange({ ...loop, collectFrom: bodySaveNames[0] ?? '', collectVar: '' });
    } else {
      const rest = { ...loop };
      delete rest.collectFrom;
      delete rest.collectVar;
      onChange(rest);
    }
  };

  const iterationChoices = ITERATION_CHOICES.includes(loop.maxIterations)
    ? ITERATION_CHOICES
    : [...ITERATION_CHOICES, loop.maxIterations].sort((a, b) => a - b);

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`loop-name-${loop.id}`}>
          Loop name
        </label>
        <input
          id={`loop-name-${loop.id}`}
          className={inputClass}
          value={loop.name}
          maxLength={80}
          placeholder="e.g. Handle each ticket"
          onChange={(event) => onChange({ ...loop, name: event.target.value })}
        />
      </div>

      <div>
        <span className={labelClass}>What kind of loop?</span>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Loop kind">
          <button
            type="button"
            role="radio"
            aria-checked={loop.mode === 'foreach'}
            onClick={() => {
              if (loop.mode !== 'foreach') onChange(toForeach());
            }}
            className={`rounded-md border px-3 py-2 text-left text-sm ${
              loop.mode === 'foreach'
                ? 'border-amber-500 bg-amber-50 font-medium dark:bg-amber-950/40'
                : 'border-gray-300 dark:border-gray-700'
            }`}
          >
            For each item in a list
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={loop.mode === 'until'}
            onClick={() => {
              if (loop.mode !== 'until') onChange(toUntil());
            }}
            className={`rounded-md border px-3 py-2 text-left text-sm ${
              loop.mode === 'until'
                ? 'border-amber-500 bg-amber-50 font-medium dark:bg-amber-950/40'
                : 'border-gray-300 dark:border-gray-700'
            }`}
          >
            Repeat until something is true
          </button>
        </div>
      </div>

      {loop.mode === 'foreach' ? (
        <>
          <div>
            <label className={labelClass} htmlFor={`loop-items-${loop.id}`}>
              The list to go through
            </label>
            <select
              id={`loop-items-${loop.id}`}
              className={inputClass}
              value={loop.itemsVar}
              onChange={(event) => onChange({ ...loop, itemsVar: event.target.value })}
            >
              <option value="">Choose a saved list…</option>
              {variables.map((variable) => (
                <option key={variable.name} value={variable.name}>
                  {variable.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              A result an earlier step saved as a list of items — one round runs per item.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor={`loop-item-${loop.id}`}>
              Call each item
            </label>
            <input
              id={`loop-item-${loop.id}`}
              className={inputClass}
              value={loop.itemVar}
              maxLength={64}
              placeholder="e.g. ticket"
              onChange={(event) => onChange({ ...loop, itemVar: event.target.value })}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Steps inside the loop reference the current item under this name.
            </p>
          </div>
        </>
      ) : (
        <div>
          <label className={labelClass}>Stop when…</label>
          <ChipEditor
            value={loop.condition}
            onChange={(condition) => onChange({ ...loop, condition })}
            // No tools on purpose: the check judges what the body already
            // did — do tool work in the body, save it, and check that.
            tools={[]}
            variables={variables}
            maxTools={0}
            placeholder="A yes/no question checked after each round — type / to reference a saved detail"
            ariaLabel={`Stop condition for loop ${loop.name || 'unnamed'}`}
            invalidVars={invalidVars}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Checked AFTER each round — the steps inside always run at least once. If the round limit
            is reached and this still isn’t true, the run fails.
          </p>
        </div>
      )}

      <div>
        <label className={labelClass} htmlFor={`loop-max-${loop.id}`}>
          At most how many rounds?
        </label>
        <select
          id={`loop-max-${loop.id}`}
          className={inputClass}
          value={loop.maxIterations}
          onChange={(event) => onChange({ ...loop, maxIterations: Number(event.target.value) })}
        >
          {iterationChoices
            .filter((choice) => choice <= MAX_LOOP_ITERATIONS)
            .map((choice) => (
              <option key={choice} value={choice}>
                {choice} round{choice === 1 ? '' : 's'}
              </option>
            ))}
        </select>
        {loop.mode === 'foreach' ? (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Items past the limit are skipped, with a note in the run history.
          </p>
        ) : null}
      </div>

      <div className="rounded-md border border-violet-200 p-3 dark:border-violet-900">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={loop.collectVar !== undefined}
            onChange={(event) => setCollect(event.target.checked)}
          />
          Collect results into a list
        </label>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Each round adds what a step inside saved — the list can be used by later steps, or by
          another loop. Rounds that save nothing add nothing.
        </p>
        {loop.collectVar !== undefined ? (
          <div className="mt-2 space-y-2">
            <div>
              <label className={labelClass} htmlFor={`loop-collect-from-${loop.id}`}>
                Collect from
              </label>
              <select
                id={`loop-collect-from-${loop.id}`}
                className={inputClass}
                value={loop.collectFrom ?? ''}
                onChange={(event) => onChange({ ...loop, collectFrom: event.target.value })}
              >
                <option value="">Choose a result saved inside this loop…</option>
                {bodySaveNames.map((saveName) => (
                  <option key={saveName} value={saveName}>
                    {saveName}
                  </option>
                ))}
              </select>
              {bodySaveNames.length === 0 ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  No step inside this loop saves a result yet — add one, name its result, then pick
                  it here.
                </p>
              ) : null}
            </div>
            <div>
              <label className={labelClass} htmlFor={`loop-collect-var-${loop.id}`}>
                Call the list
              </label>
              <input
                id={`loop-collect-var-${loop.id}`}
                className={inputClass}
                value={loop.collectVar}
                maxLength={64}
                placeholder="e.g. summaries"
                onChange={(event) => onChange({ ...loop, collectVar: event.target.value })}
              />
            </div>
          </div>
        ) : null}
      </div>

      {loop.mode === 'until' && loop.condition.length > 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          Checks: {instructionPreview(loop.condition)}
        </p>
      ) : null}

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
