'use client';

/**
 * The read/write checkbox pair over the three-level access ladder, shared
 * by the Access section (grant defaults) and the Permissions panel (path
 * rules): neither = no access, read = read, both = read/write. Checking
 * write implies read; unchecking read clears write with it. `ceiling`
 * grays out what the level above does not allow — a box you cannot check
 * because nobody below that level may hold it here.
 */

export type AccessLevelView = 'none' | 'read' | 'read_write';

export function AccessCheckboxes({
  name,
  level,
  ceiling,
  disabled = false,
  onLevel,
}: {
  /** Accessible-name prefix: boxes are labeled "{name}: read" / "{name}: write". */
  name: string;
  level: AccessLevelView;
  ceiling: AccessLevelView;
  disabled?: boolean;
  onLevel: (next: AccessLevelView) => void;
}) {
  const box = (
    label: 'read' | 'write',
    checked: boolean,
    boxDisabled: boolean,
    onToggle: (checked: boolean) => void
  ) => (
    <label
      className={`flex items-center gap-1 text-xs ${
        boxDisabled ? 'opacity-40' : 'cursor-pointer'
      } text-gray-600 dark:text-gray-400`}
    >
      <input
        type="checkbox"
        aria-label={`${name}: ${label}`}
        className="h-4 w-4 accent-blue-600"
        checked={checked}
        disabled={boxDisabled}
        onChange={(event) => onToggle(event.target.checked)}
      />
      {label}
    </label>
  );

  return (
    <span className="flex shrink-0 items-center gap-3">
      {box('read', level !== 'none', disabled || ceiling === 'none', (checked) =>
        onLevel(checked ? 'read' : 'none')
      )}
      {box('write', level === 'read_write', disabled || ceiling !== 'read_write', (checked) =>
        onLevel(checked ? 'read_write' : 'read')
      )}
    </span>
  );
}
