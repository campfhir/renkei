'use client';

/**
 * The editor-panel body for a branch node: name, the yes/no condition (var
 * chips allowed, tool chips deliberately not — the evaluator has no tools),
 * and the two path names. The paths' STEPS are edited on the canvas, where
 * they render as nested columns.
 */

import type { BranchStep } from '@renkei/agents';
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
  const renamePath = (index: 0 | 1, name: string) => {
    const paths: BranchStep['paths'] = [
      index === 0 ? { ...branch.paths[0], name } : branch.paths[0],
      index === 1 ? { ...branch.paths[1], name } : branch.paths[1],
    ];
    onChange({ ...branch, paths });
  };

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
          placeholder="A yes/no question in plain words — type / to reference a saved detail"
          ariaLabel={`Condition for branch ${branch.name || 'unnamed'}`}
          invalidVars={invalidVars}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The agent answers yes or no from what it already knows; after either path finishes, the
          flow continues below the branch.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass} htmlFor={`branch-yes-${branch.id}`}>
            If yes, path
          </label>
          <input
            id={`branch-yes-${branch.id}`}
            className={inputClass}
            value={branch.paths[0].name}
            maxLength={80}
            onChange={(event) => renamePath(0, event.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`branch-no-${branch.id}`}>
            If no, path
          </label>
          <input
            id={`branch-no-${branch.id}`}
            className={inputClass}
            value={branch.paths[1].name}
            maxLength={80}
            onChange={(event) => renamePath(1, event.target.value)}
          />
        </div>
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
