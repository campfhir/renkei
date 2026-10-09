'use client';

/**
 * The editor-panel body for a group node — just its name: a group is pure
 * structure, so there is nothing else to configure. The steps inside are
 * edited on the canvas.
 */

import type { GroupStep } from '@renkei/agents';
import { FieldIssues, exceptFields, fieldClass, forField, type NodeIssue } from './field-issues';

export function GroupEditor({
  group,
  onChange,
  issues,
}: {
  group: GroupStep;
  onChange: (group: GroupStep) => void;
  issues: NodeIssue[];
}) {
  const nameIssues = forField(issues, 'name');
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-sm font-medium" htmlFor={`group-name-${group.id}`}>
          Group name
        </label>
        <input
          id={`group-name-${group.id}`}
          className={fieldClass(nameIssues.length > 0)}
          aria-invalid={nameIssues.length > 0 || undefined}
          value={group.name}
          maxLength={80}
          placeholder="e.g. Triage"
          onChange={(event) => onChange({ ...group, name: event.target.value })}
        />
        <FieldIssues messages={nameIssues} />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Groups only organize the canvas — the steps inside run exactly as if the group weren’t
          there.
        </p>
      </div>

      <FieldIssues messages={exceptFields(issues, 'name')} />
    </div>
  );
}
