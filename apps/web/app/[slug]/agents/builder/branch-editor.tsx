'use client';

/**
 * The editor-panel body for a branch node: name, the condition (var chips
 * allowed, tool chips deliberately not — the evaluator has no tools), the
 * 2..5 labeled paths (the last is the "otherwise" fallback), and the
 * optional red failure route taken when the DECISION itself keeps erroring.
 * The paths' STEPS are edited on the canvas, where they render as columns
 * or router rows.
 */

import RemoveButton from '@/components/remove-button';
import { MAX_BRANCH_PATHS, type BranchPath, type BranchStep } from '@renkei/agents';
import { randomUUID } from '@/lib/agents/uuid';
import { ChipEditor } from './chip-editor';
import type { VariableOption } from './options';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';

export function BranchEditor({
  branch,
  onChange,
  variables,
  invalidVars,
  issues,
}: {
  branch: BranchStep;
  onChange: (branch: BranchStep) => void;
  variables: VariableOption[];
  invalidVars?: ReadonlySet<string>;
  issues: string[];
}) {
  const renamePath = (index: number, name: string) => {
    onChange({
      ...branch,
      paths: branch.paths.map((path, at) => (at === index ? { ...path, name } : path)),
    });
  };

  const addPath = () => {
    if (branch.paths.length >= MAX_BRANCH_PATHS) return;
    // New routes slot in BEFORE the fallback, which stays last.
    const paths = [...branch.paths];
    paths.splice(paths.length - 1, 0, { id: randomUUID(), name: '', steps: [] });
    onChange({ ...branch, paths });
  };

  const removePath = (index: number) => {
    if (branch.paths.length <= 2) return;
    const path = branch.paths[index];
    if (
      path.steps.length > 0 &&
      !window.confirm(`Remove the path "${path.name || 'unnamed'}" and every step inside it?`)
    ) {
      return;
    }
    onChange({ ...branch, paths: branch.paths.filter((_, at) => at !== index) });
  };

  const movePath = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= branch.paths.length) return;
    const paths = [...branch.paths];
    [paths[index], paths[target]] = [paths[target], paths[index]];
    onChange({ ...branch, paths });
  };

  const setFailurePath = (on: boolean) => {
    if (on === (branch.failurePath !== undefined)) return;
    if (on) {
      const failurePath: BranchPath = { id: randomUUID(), name: 'If this fails', steps: [] };
      onChange({ ...branch, failurePath });
    } else {
      if (
        branch.failurePath &&
        branch.failurePath.steps.length > 0 &&
        !window.confirm('Remove the failure route and every step inside it?')
      ) {
        return;
      }
      const rest = { ...branch };
      delete rest.failurePath;
      onChange(rest);
    }
  };

  const twoWay = branch.paths.length === 2;

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`branch-name-${branch.id}`}>
          Branch name
        </label>
        <input
          id={`branch-name-${branch.id}`}
          className={inputClass}
          value={branch.name}
          maxLength={80}
          placeholder="e.g. Was a ticket found?"
          onChange={(event) => onChange({ ...branch, name: event.target.value })}
        />
      </div>

      <div>
        <label className={labelClass}>What should it check?</label>
        <ChipEditor
          value={branch.condition}
          onChange={(condition) => onChange({ ...branch, condition })}
          // No tools on purpose: a branch judges, it doesn't act. Do tool
          // work in a step above, save the result, and branch on it.
          tools={[]}
          variables={variables}
          maxTools={0}
          placeholder={
            twoWay
              ? 'A yes/no question in plain words — type / to reference a saved detail'
              : 'What decides between the paths below — type / to reference a saved detail'
          }
          ariaLabel={`Condition for branch ${branch.name || 'unnamed'}`}
          invalidVars={invalidVars}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {twoWay
            ? 'The agent answers yes or no from what it already knows; after either path finishes, the flow continues below the branch.'
            : 'The agent picks exactly one path from what it already knows — the last one when nothing clearly applies. After a path finishes, the flow continues below the branch.'}
        </p>
      </div>

      <div>
        <span className={labelClass}>Paths</span>
        <ul className="space-y-2">
          {branch.paths.map((path, index) => {
            const isLast = index === branch.paths.length - 1;
            const caption = twoWay
              ? index === 0
                ? 'If yes'
                : 'If no'
              : isLast
                ? 'Otherwise'
                : `Path ${index + 1}`;
            return (
              <li key={path.id} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">
                  {caption}
                </span>
                <input
                  aria-label={`Name of path ${index + 1}`}
                  className={inputClass}
                  value={path.name}
                  maxLength={80}
                  onChange={(event) => renamePath(index, event.target.value)}
                />
                <button
                  type="button"
                  aria-label={`Move path ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => movePath(index, -1)}
                  className="rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-30 dark:border-gray-800 dark:hover:text-gray-200"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move path ${index + 1} down`}
                  disabled={isLast}
                  onClick={() => movePath(index, 1)}
                  className="rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-30 dark:border-gray-800 dark:hover:text-gray-200"
                >
                  ↓
                </button>
                <RemoveButton
                  compact
                  label={`Remove path ${index + 1}`}
                  disabled={branch.paths.length <= 2}
                  onClick={() => removePath(index)}
                />
              </li>
            );
          })}
        </ul>
        {branch.paths.length < MAX_BRANCH_PATHS ? (
          <button
            type="button"
            onClick={addPath}
            className="mt-2 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            + Add a path
          </button>
        ) : (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            A branch routes between at most {MAX_BRANCH_PATHS} paths.
          </p>
        )}
      </div>

      <div className="rounded-md border border-red-200 p-3 dark:border-red-900">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={branch.failurePath !== undefined}
            onChange={(event) => setFailurePath(event.target.checked)}
          />
          If this decision fails, take a failure route
        </label>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Taken only when the decision itself keeps erroring — never chosen by the agent. Leave its
          steps empty to shrug the failure off and continue below the branch. Without it, a failed
          decision fails the run.
        </p>
        {branch.failurePath ? (
          <div className="mt-2">
            <label className={labelClass} htmlFor={`branch-failure-${branch.id}`}>
              Failure route name
            </label>
            <input
              id={`branch-failure-${branch.id}`}
              className={inputClass}
              value={branch.failurePath.name}
              maxLength={80}
              onChange={(event) =>
                onChange({
                  ...branch,
                  failurePath: branch.failurePath
                    ? { ...branch.failurePath, name: event.target.value }
                    : branch.failurePath,
                })
              }
            />
          </div>
        ) : null}
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
